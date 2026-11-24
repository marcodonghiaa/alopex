import { assertEquals } from "jsr:@std/assert@1.0.19";
import { cryptoRows, type GetJson, type Holding, nextAssetType, priceHoldings, syncCrypto, syncFx } from "./prices.ts";

const holding = (over: Partial<Holding> = {}): Holding => ({ user_id: "u1", isin: "IE00", yahoo_symbol: "VWCE.DE", shares: 2, asset_type: null, ...over });
const quiet = async <T>(run: () => Promise<T>) => {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
};

// protects=each holding gets today's value in EUR without a Mac; fails_when=a symbol held twice is
// fetched twice, one bad holding drops the rest, or a hand-set Bond label is overwritten
Deno.test("prices each holding once per symbol, converts to EUR and skips what can't be priced", async () => {
  let quotes = 0;
  const { rows, typeUpdates } = await quiet(() =>
    priceHoldings(
      [holding(), holding({ user_id: "u2" }), holding({ isin: "BAD", yahoo_symbol: "NOPE" }), holding({ isin: "BND", yahoo_symbol: "AGGH", asset_type: "Bond" })],
      async (symbol) => {
        quotes++;
        if (symbol === "NOPE") throw Object.assign(new Error("No valid price"), { name: "HoldingError" });
        return { price: 100, currency: "USD", assetType: "ETF" };
      },
      async () => 0.9,
      "2026-11-06",
    )
  );
  assertEquals(quotes, 3);
  assertEquals(rows.map((r) => [r.user_id, r.isin, r.value_native, r.value_eur]), [["u1", "IE00", 200, 180], ["u2", "IE00", 200, 180], ["u1", "BND", 200, 180]]);
  assertEquals(typeUpdates, [{ user_id: "u1", isin: "IE00", asset_type: "ETF" }, { user_id: "u2", isin: "IE00", asset_type: "ETF" }]);
  assertEquals([nextAssetType("Bond", "ETF"), nextAssetType("Stock", "ETF"), nextAssetType(null, "ETF")], ["Bond", "ETF", "ETF"]);
});

Deno.test("crypto rows: USD value converted to EUR, a coin without a price skipped", async () => {
  const rows = await quiet(async () =>
    cryptoRows(
      [
        { user_id: "u1", asset_symbol: "BTC", amount: 0.5, source: "Ledger", coingecko_id: "bitcoin" },
        { user_id: "u1", asset_symbol: "XXX", amount: 3, source: "Ledger", coingecko_id: "gone" },
      ],
      { bitcoin: { usd: 60000 }, gone: { usd: 0 } },
      0.9,
      "2026-11-06",
    )
  );
  assertEquals(rows, [{ user_id: "u1", asset_symbol: "BTC", source: "Ledger", snapshot_date: "2026-11-06", amount: 0.5, price_usd: 60000, value_usd: 30000, value_eur: 27000 }]);
});

function fxDb(hasHistory: boolean) {
  const upserts: unknown[][] = [];
  const db = {
    from: () => {
      const q = {
        select: () => q,
        lt: () => q,
        limit: async () => ({ data: hasHistory ? [{ date: "2026-07-01" }] : [], error: null }),
        upsert: async (rows: unknown[]) => (upserts.push(rows), { error: null }),
      };
      return q;
    },
  };
  return { db, upserts };
}
const fakeGet = (urls: string[]): GetJson => async (url) => {
  urls.push(url);
  return url.includes("latest")
    ? { date: "2026-11-06", rates: { USD: 1.25 } }
    : { start_date: "2026-07-29", rates: { "2026-07-29": { USD: 1.2 }, "2026-07-30": { USD: 1.1 } } };
};

Deno.test("fx: latest rates every run, plus 100 days of history only on a fresh install", async () => {
  const fresh = fxDb(false);
  const urls: string[] = [];
  assertEquals(await syncFx(fresh.db, fakeGet(urls)), 6);
  assertEquals(urls.length, 2);
  assertEquals(fresh.upserts[1], [{ date: "2026-11-06", currency: "EUR", rate_to_eur: 1 }, { date: "2026-11-06", currency: "USD", rate_to_eur: 0.8 }]);

  const existing = fxDb(true);
  const urls2: string[] = [];
  assertEquals(await syncFx(existing.db, fakeGet(urls2)), 2);
  assertEquals(urls2, ["https://api.frankfurter.dev/v1/latest?base=EUR"]);
});

Deno.test("stops pricing holdings once the time is up", async () => {
  let checks = 0;
  const { rows } = await quiet(() =>
    priceHoldings([holding({ isin: "A", yahoo_symbol: "A" }), holding({ isin: "B", yahoo_symbol: "B" })], async () => ({ price: 1, currency: "EUR", assetType: "ETF" }), async () => 1, "2026-11-06", () => checks++ < 1)
  );
  assertEquals(rows.map((r) => r.isin), ["A"]);
});

// H004: Postgres numeric holds NaN and Infinity, and JSON turns 1e400 into Infinity. One such
// holding gave a null value, and the one upsert for every user failed, so nobody got prices.
Deno.test("a holding with a NaN, infinite or huge quantity is skipped, the others are priced", async () => {
  const { rows } = await quiet(() =>
    priceHoldings(
      [
        holding({ user_id: "bad1", shares: Number.NaN }),
        holding({ user_id: "bad2", shares: "Infinity" as unknown as number }),
        holding({ user_id: "bad3", shares: 1e400 }),
        holding({ user_id: "bad4", shares: 1e308 }),
        holding({ user_id: "good" }),
      ],
      async () => ({ price: 100, currency: "EUR", assetType: "" }),
      async () => 1,
      "2026-11-06",
    )
  );
  assertEquals(rows.map((r) => [r.user_id, r.value_eur]), [["good", 200]]);
});

Deno.test("crypto rows: a holding with a NaN or infinite amount is skipped, the others kept", async () => {
  const rows = await quiet(async () =>
    cryptoRows(
      [
        { user_id: "bad1", asset_symbol: "BTC", amount: Number.NaN, source: "Manual", coingecko_id: "bitcoin" },
        { user_id: "bad2", asset_symbol: "BTC", amount: "Infinity" as unknown as number, source: "Manual", coingecko_id: "bitcoin" },
        { user_id: "bad3", asset_symbol: "BTC", amount: 1e400, source: "Manual", coingecko_id: "bitcoin" },
        { user_id: "good", asset_symbol: "BTC", amount: 1, source: "Manual", coingecko_id: "bitcoin" },
      ],
      { bitcoin: { usd: 100 } },
      0.5,
      "2026-11-06",
    )
  );
  assertEquals(rows.map((r) => [r.user_id, r.value_eur]), [["good", 50]]);
});

// H048: one unordered select (PostgREST answers at most 1000 rows) and one CoinGecko URL with
// every user's ids, so a few users with many coins left everyone after row 1000 unpriced.
function cappedDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const upserts: unknown[][] = [];
  const db = {
    from: (table: string) => {
      let window: [number, number] = [0, 999];
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: (n: number) => ((window = [0, n - 1]), q),
        range: (a: number, b: number) => ((window = [a, Math.min(b, a + 999)]), q),
        upsert: async (rows: unknown[]) => (upserts.push(rows), { error: null }),
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: (tables[table] ?? []).slice(window[0], window[1] + 1), error: null }),
      };
      return q;
    },
  };
  return { db, upserts };
}
Deno.test("crypto: every holding past row 1000 is priced, and CoinGecko is asked in batches", async () => {
  const holdings = Array.from({ length: 1500 }, (_, i) => ({
    user_id: `u${i % 7}`, asset_symbol: `C${i}`, amount: 1, source: "Manual", coingecko_id: `coin-${i % 250}`,
  }));
  const { db, upserts } = cappedDb({ crypto_holdings: holdings, fx_rates: [{ rate_to_eur: 0.9 }] });
  const urls: string[] = [];
  const get: GetJson = async (url) => {
    urls.push(url);
    const ids = decodeURIComponent(new URL(url).searchParams.get("ids")!).split(",");
    return Object.fromEntries(ids.map((id) => [id, { usd: 2 }]));
  };
  assertEquals(await syncCrypto(db, get, "2026-11-23"), 1500);
  assertEquals(upserts.flat().length, 1500);
  assertEquals(urls.every((u) => decodeURIComponent(new URL(u).searchParams.get("ids")!).split(",").length <= 100), true);
  assertEquals(urls.length, 3);
});
