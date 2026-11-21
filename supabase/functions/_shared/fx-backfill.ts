// Past exchange rates for foreign-currency transactions older than the first stored rate. A fresh
// install stores rates from the day it is set up, and v_transactions_eur uses the latest rate on or
// before each booking day, so every older foreign row had no euro amount: missing from Spent,
// budgets and cash flow, and the Splitwise import refused it (e2e #8, #11). Frankfurter (ECB
// rates, the source sync-prices uses) answers a date range in one call per currency.
import { errorTag } from "./log-safe.ts";

type Get = (url: string) => Promise<unknown>;
type Gap = { currency: string; from_date: string; to_date: string };
// deno-lint-ignore no-explicit-any
type Db = { rpc: (fn: string) => PromiseLike<{ data: any; error: unknown }>; from: (t: string) => any };

const weekBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);

/** Stores the missing rates; returns how many rows it stored. Best effort per currency. */
export async function backfillFx(db: Db, get: Get): Promise<number> {
  const { data, error } = await db.rpc("fx_backfill_needed");
  if (error) throw error;
  let stored = 0;
  for (const gap of (data ?? []) as Gap[]) {
    try {
      // A week earlier, so a weekend or holiday booking has the last working day's rate.
      const url = `https://api.frankfurter.dev/v1/${weekBefore(gap.from_date)}..${gap.to_date}?base=EUR&symbols=${gap.currency}`;
      const body = (await get(url)) as { rates?: Record<string, Record<string, unknown>> };
      const rows = Object.entries(body.rates ?? {}).flatMap(([date, rates]) => {
        const units = rates[gap.currency];
        return typeof units === "number" && Number.isFinite(units) && units > 0
          ? [{ date, currency: gap.currency, rate_to_eur: 1 / units }]
          : [];
      });
      if (rows.length === 0) continue;
      const { error: saveError } = await db.from("fx_rates").upsert(rows, { onConflict: "date,currency", ignoreDuplicates: true });
      if (saveError) throw saveError;
      stored += rows.length;
    } catch (err) {
      console.error(`fx backfill for one currency failed: ${errorTag(err)}`);
    }
  }
  return stored;
}
