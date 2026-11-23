import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  AlreadyHeld,
  refuseHeldElsewhere,
  HoldingError,
  isIsin,
  parseCoinGeckoPrice,
  parseCoinGeckoSearch,
  parseHoldingRequest,
  parseYahooChart,
  parseYahooSearch,
  upstreamMessage,
} from "./holdings.ts";

Deno.test("isIsin accepts real ISINs only", () => {
  assertEquals(isIsin("IE00B4L5Y983"), true);
  for (const bad of ["IE00B4L5Y98", "ie00b4l5y983", "VWCE", "IE00B4L5Y98X", ""]) {
    assertEquals(isIsin(bad), false, bad);
  }
});

Deno.test("Yahoo search keeps securities and drops news, futures and options", () => {
  const candidates = parseYahooSearch({
    quotes: [
      { symbol: "VWCE.DE", longname: "Vanguard FTSE All-World", quoteType: "ETF", exchDisp: "XETRA" },
      { symbol: "AAPL", shortname: "Apple Inc.", quoteType: "EQUITY", exchDisp: "NASDAQ" },
      { symbol: "ES=F", shortname: "S&P Future", quoteType: "FUTURE" },
      { symbol: "X", quoteType: "EQUITY" }, // no name
    ],
  });
  assertEquals(candidates, [
    { id: "VWCE.DE", symbol: "VWCE.DE", name: "Vanguard FTSE All-World", detail: "ETF · XETRA" },
    { id: "AAPL", symbol: "AAPL", name: "Apple Inc.", detail: "Stock · NASDAQ" },
  ]);
  assertEquals(parseYahooSearch({ quotes: [] }), []);
  assertThrows(() => parseYahooSearch({}), HoldingError, "unexpected reply");
});

Deno.test("Yahoo chart gives price, currency and type; pence become pounds", () => {
  assertEquals(
    parseYahooChart({ chart: { result: [{ meta: { regularMarketPrice: 120.5, currency: "EUR", instrumentType: "ETF" } }] } }, "VWCE.DE"),
    { price: 120.5, currency: "EUR", assetType: "ETF" },
  );
  assertEquals(
    parseYahooChart({ chart: { result: [{ meta: { regularMarketPrice: 1234, currency: "GBp", instrumentType: "EQUITY" } }] } }, "VOD.L"),
    { price: 12.34, currency: "GBP", assetType: "Stock" },
  );
  assertThrows(() => parseYahooChart({ chart: { result: [{ meta: { currency: "EUR" } }] } }, "X"), Error, "No valid price");
  assertThrows(() => parseYahooChart({ chart: { result: [] } }, "X"), Error, "No quote");
  assertThrows(() => parseYahooChart({ chart: { result: [{ meta: { regularMarketPrice: 0, currency: "EUR" } }] } }, "X"), HoldingError, "No valid price");
});

Deno.test("CoinGecko search keeps the top coins with an id, symbol and name", () => {
  assertEquals(
    parseCoinGeckoSearch({
      coins: [
        { id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap_rank: 1 },
        { id: "", symbol: "x", name: "Broken" },
      ],
    }),
    [{ id: "bitcoin", symbol: "BTC", name: "Bitcoin", detail: "Rank #1" }],
  );
});

Deno.test("CoinGecko search treats an empty list as no results and a bad reply as an error", () => {
  assertEquals(parseCoinGeckoSearch({ coins: [] }), []);
  assertThrows(() => parseCoinGeckoSearch({ status: {} }), HoldingError, "unexpected reply");
});

Deno.test("CoinGecko price must be above zero", () => {
  assertEquals(parseCoinGeckoPrice({ ethereum: { usd: 2247.65 } }, "ethereum"), 2247.65);
  for (const bad of [{}, { ethereum: {} }, { ethereum: { usd: 0 } }, { ethereum: { usd: "1" } }]) {
    assertThrows(() => parseCoinGeckoPrice(bad, "ethereum"), HoldingError, "no price for ethereum");
  }
});

Deno.test("upstream failures name the provider and what happened", () => {
  assertEquals(
    upstreamMessage("api.coingecko.com", 429),
    "CoinGecko is limiting requests from this server (error 429), try again in a minute",
  );
  assertEquals(
    upstreamMessage("query1.finance.yahoo.com", 403),
    "Yahoo Finance is limiting requests from this server (error 403), try again in a minute",
  );
  assertEquals(upstreamMessage("query1.finance.yahoo.com", 404), "Yahoo Finance has no price for this (error 404)");
  assertEquals(upstreamMessage("api.coingecko.com", 500), "CoinGecko is unavailable right now (error 500), try again");
});

Deno.test("a search request needs a kind and a short query", () => {
  assertEquals(parseHoldingRequest({ action: "search", kind: "stock", query: "  vwce " }), {
    action: "search",
    kind: "stock",
    query: "vwce",
  });
  for (const bad of [
    { action: "search", kind: "bond", query: "x" },
    { action: "search", kind: "stock", query: "" },
    { action: "search", kind: "stock", query: "x".repeat(51) },
    { action: "delete", kind: "stock", query: "x" },
    null,
  ]) {
    assertEquals(typeof parseHoldingRequest(bad), "string", JSON.stringify(bad));
  }
});

Deno.test("an add request needs a valid id, name and a positive quantity", () => {
  const stock = { action: "add", kind: "stock", id: "VWCE.DE", symbol: "VWCE.DE", name: "Vanguard", quantity: 3.5, isin: "IE00BK5BQT80", broker: "Degiro" } as const;
  assertEquals(parseHoldingRequest(stock), stock);
  assertEquals(parseHoldingRequest({ ...stock, isin: undefined, broker: undefined }), {
    ...stock,
    isin: undefined,
    broker: undefined,
  });
  for (const patch of [
    { quantity: 0 },
    { quantity: -1 },
    { quantity: "3" },
    { quantity: Infinity },
    { id: "bad symbol!" },
    { name: "" },
    { isin: "nope" },
    { broker: "x".repeat(41) },
  ]) {
    assertEquals(typeof parseHoldingRequest({ ...stock, ...patch }), "string", JSON.stringify(patch));
  }
  const coin = { action: "add", kind: "crypto", id: "bitcoin", symbol: "BTC", name: "Bitcoin", quantity: 0.25 } as const;
  assertEquals(parseHoldingRequest(coin), { ...coin, isin: undefined, broker: undefined });
  assertEquals(typeof parseHoldingRequest({ ...coin, id: "Bitcoin!" }), "string");
});

// H017: a stock added by name or ticker is keyed by its Yahoo symbol; adding it again by ISIN (a
// broker import) made a second holding, priced and counted in net worth twice.
// A tiny portfolio_holdings: select/eq/neq/limit filter these rows, like PostgREST would.
const holdingsDb = (rows: Array<Record<string, string>>) => ({
  from: (table: string) => {
    assertEquals(table, "portfolio_holdings");
    let found = rows;
    const q = {
      select: () => q,
      eq: (c: string, v: string) => ((found = found.filter((r) => r[c] === v)), q),
      neq: (c: string, v: string) => ((found = found.filter((r) => r[c] !== v)), q),
      limit: async (n: number) => ({ data: found.slice(0, n), error: null }),
    };
    return q;
  },
});
const HELD = [{ user_id: "u1", isin: "VWCE.DE", yahoo_symbol: "VWCE.DE" }, { user_id: "u2", isin: "IE00BK5BQT80", yahoo_symbol: "VWCE.DE" }];
const refusal = (db: ReturnType<typeof holdingsDb>, user: string, key: string) =>
  refuseHeldElsewhere(db, user, "VWCE.DE", key).then(() => null, (e) => e);

Deno.test("adding by ISIN a stock you hold by ticker is refused with the key you hold it under", async () => {
  const err = await refusal(holdingsDb(HELD), "u1", "IE00BK5BQT80");
  assertEquals([err instanceof AlreadyHeld, (err as AlreadyHeld).key], [true, "VWCE.DE"]);
});

// Re-adding under the same key is left to the insert's unique key (its friendlier message).
Deno.test("re-adding under the same key, or a symbol only someone else holds, is not refused here", async () => {
  assertEquals(await refusal(holdingsDb(HELD), "u1", "VWCE.DE"), null);
  assertEquals(await refusal(holdingsDb(HELD), "u3", "IE00BK5BQT80"), null);
});

Deno.test("a failed read is passed on", async () => {
  const db = { from: () => { const q = { select: () => q, eq: () => q, neq: () => q, limit: async () => ({ data: null, error: { code: "XX000" } }) }; return q; } };
  assertEquals(await refuseHeldElsewhere(db, "u1", "VWCE.DE", "X").catch((e) => e), { code: "XX000" });
});
