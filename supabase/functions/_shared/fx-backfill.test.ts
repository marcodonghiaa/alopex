import { assertEquals } from "jsr:@std/assert@1.0.19";
import { backfillFx } from "./fx-backfill.ts";

// A fresh install stores rates from today on, so every older foreign-currency row had no euro
// amount: left out of Spent, budgets and cash flow (e2e #8).
const fakeDb = (gaps: Array<{ currency: string; from_date: string; to_date: string }>) => {
  const upserts: unknown[][] = [];
  return {
    upserts,
    rpc: (name: string) => Promise.resolve(name === "fx_backfill_needed" ? { data: gaps, error: null } : { data: null, error: { message: "?" } }),
    from: (_t: string) => ({
      upsert: (rows: unknown[], _o: unknown) => (upserts.push(rows), Promise.resolve({ error: null })),
    }),
  };
};

Deno.test("fx backfill: fetches the missing days (from a week before, for weekends) and stores them", async () => {
  const db = fakeDb([{ currency: "USD", from_date: "2026-08-16", to_date: "2026-11-20" }]);
  const urls: string[] = [];
  const get = (url: string) => {
    urls.push(url);
    return Promise.resolve({ rates: { "2026-08-10": { USD: 1.25 }, "2026-08-11": { USD: 1.0 } } });
  };
  assertEquals(await backfillFx(db, get), 2);
  assertEquals(urls, ["https://api.frankfurter.dev/v1/2026-08-09..2026-11-20?base=EUR&symbols=USD"]);
  assertEquals(db.upserts[0], [
    { date: "2026-08-10", currency: "USD", rate_to_eur: 0.8 },
    { date: "2026-08-11", currency: "USD", rate_to_eur: 1 },
  ]);
});

Deno.test("fx backfill: nothing missing, no call; one bad currency does not stop the others", async () => {
  assertEquals(await backfillFx(fakeDb([]), () => Promise.reject(new Error("no call expected"))), 0);
  const db = fakeDb([
    { currency: "XYZ", from_date: "2026-08-16", to_date: "2026-11-20" },
    { currency: "GBP", from_date: "2026-11-01", to_date: "2026-11-20" },
  ]);
  const get = (url: string) =>
    url.includes("XYZ") ? Promise.reject(new Error("404")) : Promise.resolve({ rates: { "2026-10-30": { GBP: 0.5 } } });
  assertEquals(await backfillFx(db, get), 1);
});

Deno.test("fx backfill: a rate that is not a positive number is never stored", async () => {
  const db = fakeDb([{ currency: "USD", from_date: "2026-08-16", to_date: "2026-11-20" }]);
  const get = () => Promise.resolve({ rates: { "2026-08-10": { USD: 0 }, "2026-08-11": { USD: "x" } } });
  assertEquals(await backfillFx(db, get), 0);
  assertEquals(db.upserts.length, 0);
});
