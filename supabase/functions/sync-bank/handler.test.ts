import { assertEquals } from "jsr:@std/assert@1.0.19";
import { syncBankHandler } from "./handler.ts";
import { memoryDb } from "../_shared/memory-db.test-helper.ts";

// H289: the money path around the shared bank-sync steps: what is saved, and when the cursor moves.
const KEY = "sb_secret_test";
const TODAY = new Date().toISOString().slice(0, 10);
const TX = {
  entry_reference: "r1",
  transaction_amount: { amount: "-3.20", currency: "EUR" },
  credit_debit_indicator: "DBIT",
  booking_date: TODAY,
  value_date: TODAY,
};
const BALANCES = { balances: [{ balance_amount: { amount: "12.50", currency: "EUR" } }] };

const seed = (sync_error: string | null = null) =>
  memoryDb({
    accounts: [{ uid: "pk", user_id: "u1", eb_account_uid: null, identification_hash: "h", consent_valid_until: null, account_type: "checking", sync_error }],
    sync_cursors: [{ account_uid: "pk", last_synced: "2026-01-01" }],
    transactions: [],
    net_worth_snapshots: [],
  });

// Answers by URL part; records every URL called.
const bank = (balances: { status: number; body: unknown }) => {
  const urls: string[] = [];
  const fetch = ((url: string) => {
    urls.push(url);
    const res = url.includes("/balances") ? balances : { status: 200, body: { transactions: [TX] } };
    return Promise.resolve(new Response(JSON.stringify(res.body), { status: res.status }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, urls };
};

const call = async (db: ReturnType<typeof seed>, fetch: typeof globalThis.fetch, body: unknown = { account_uid: "pk" }, key = KEY) => {
  const handler = syncBankHandler({ supabase: db, secretKeys: { default: KEY }, sign: () => Promise.resolve("tok"), fetch });
  const quiet = [console.log, console.error];
  console.log = console.error = () => {};
  try {
    const res = await handler(new Request("http://x", { method: "POST", headers: { apikey: key }, body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  } finally {
    [console.log, console.error] = quiet;
  }
};

Deno.test("sync-bank refuses a call without the secret key, or without an account", async () => {
  const { fetch, urls } = bank({ status: 200, body: BALANCES });
  assertEquals((await call(seed(), fetch, { account_uid: "pk" }, "wrong")).status, 401);
  assertEquals((await call(seed(), fetch, {})).status, 400);
  assertEquals((await call(seed(), fetch, { account_uid: "nope" })).status, 404);
  assertEquals(urls, []);
});

Deno.test("sync-bank: a full sync saves today's snapshot and the rows, moves the cursor and clears the error", async () => {
  const db = seed("HTTP_500");
  const { fetch } = bank({ status: 200, body: BALANCES });
  const { status, body } = await call(db, fetch);
  assertEquals([status, body.upserted, body.balance_saved, body.error], [200, 1, true, null]);
  assertEquals(db.tables.net_worth_snapshots.map((s) => [s.account_uid, s.snapshot_date, s.amount]), [["pk", TODAY, 12.5]]);
  assertEquals(db.tables.transactions.map((t) => t.entry_reference), ["r1"]);
  assertEquals(db.tables.sync_cursors.at(-1), { account_uid: "pk", last_synced: TODAY });
  assertEquals(db.tables.accounts[0].sync_error, null);
});

Deno.test("sync-bank: a failed balance call spends no transaction call, keeps the cursor and records the error", async () => {
  const db = seed();
  const { fetch, urls } = bank({ status: 429, body: { error: "ASPSP_RATE_LIMIT_EXCEEDED" } });
  const { status, body } = await call(db, fetch);
  assertEquals([status, body.balance_saved, body.error], [429, false, "ASPSP_RATE_LIMIT_EXCEEDED"]);
  assertEquals(urls.filter((u) => u.includes("/transactions")), []);
  assertEquals(db.tables.sync_cursors, [{ account_uid: "pk", last_synced: "2026-01-01" }]);
  assertEquals(db.tables.net_worth_snapshots, []);
  assertEquals(db.tables.accounts[0].sync_error, "ASPSP_RATE_LIMIT_EXCEEDED");
});
