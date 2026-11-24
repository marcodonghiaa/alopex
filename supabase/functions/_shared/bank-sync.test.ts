import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { type Deps, recordSyncError, signOrRecord, syncAccountBalance, syncAccountTransactions, syncErrorPatch, syncStatus } from "./bank-sync.ts";
import { memoryDb } from "./memory-db.test-helper.ts";

const EB = "https://api.enablebanking.com/accounts";
const TODAY = "2026-10-27";
const TX = {
  entry_reference: "r1",
  transaction_amount: { amount: "-3.20", currency: "EUR" },
  credit_debit_indicator: "DBIT",
  booking_date: "2026-10-26",
  value_date: "2026-10-26",
};
const BALANCES = { balances: [{ balance_amount: { amount: "12.50", currency: "EUR" } }] };
const EXPIRED = { code: 401, message: "Session is expired", error: "EXPIRED_SESSION", detail: null };
const account = (over = {}) => ({ uid: "pk", user_id: "user", eb_account_uid: "eb", identification_hash: "h", ...over });

type FakeRes = { ok?: boolean; status?: number; body?: unknown };

// Answers by URL substring; records every URL called.
function fakeFetch(responses: Record<string, FakeRes>) {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    const key = Object.keys(responses).find((part) => url.includes(part));
    assert(key, `unexpected URL ${url}`);
    const res = responses[key];
    return { ok: true, status: 200, ...res, json: async () => res.body ?? JSON.parse("not json") };
  }) as unknown as Deps["fetch"];
  return { fetch, urls };
}

// Records .upsert(rows, opts) and .update(patch) with its .eq / .is filter chain, once awaited.
// select answers with `accounts` (the user's own accounts' IBANs), or `stored` for transactions.
function fakeSupabase(error: unknown = null, accounts: { iban: string | null }[] = [], stored: unknown[] = []) {
  const writes: { table: string; op: string; data: unknown; filters?: unknown[] }[] = [];
  const supabase = {
    from: (table: string) => ({
      select: () => {
        const data = table === "transactions" ? stored : accounts;
        const query = { eq: () => query, in: () => query, not: () => query, then: (resolve: (v: unknown) => void) => resolve({ data, error }) };
        return query;
      },
      upsert: async (data: unknown, opts: unknown) => (writes.push({ table, op: "upsert", data, filters: [opts] }), { error }),
      update: (data: unknown) => {
        const filters: unknown[] = [];
        const query = {
          eq: (col: string, val: unknown) => (filters.push(["eq", col, val]), query),
          is: (col: string, val: unknown) => (filters.push(["is", col, val]), query),
          then: (resolve: (v: unknown) => void) => (writes.push({ table, op: "update", data, filters }), resolve({ error })),
        };
        return query;
      },
    }),
  };
  return { supabase, writes };
}

Deno.test("transactions: calls EB with eb_account_uid; rows and cursor use uid", async () => {
  const { fetch, urls } = fakeFetch({ "/transactions?": { body: { transactions: [TX] } } });
  const { supabase, writes } = fakeSupabase();

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), null, TODAY);

  assertEquals(urls.length, 1);
  assert(urls[0].startsWith(`${EB}/eb/transactions?`));
  assertEquals(writes[0].filters, [{ onConflict: "account_uid,entry_reference" }]);
  assert((writes[0].data as { account_uid: string }[]).every((row) => row.account_uid === "pk"));
  assertEquals(result, { upserted: 1, cursor: TODAY, error: null });
});

// H014/H016: a bank reusing an entry_reference overwrote the stored transaction with the new one.
Deno.test("transactions: a reused entry_reference is saved beside the stored row, not over it", async () => {
  const old = { ...TX, booking_date: "2026-08-01", transaction_amount: { amount: "-9.00", currency: "EUR" } };
  const { fetch } = fakeFetch({ "/transactions?": { body: { transactions: [TX] } } });
  const { supabase, writes } = fakeSupabase(null, [], [{ entry_reference: "r1", raw: old }]);

  await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-10-20", TODAY);

  const rows = writes[0].data as { entry_reference: string }[];
  assertEquals(rows.map((r) => r.entry_reference), ["r1#d55b3e31c767"]);
});

// H171: rows stored before raw was trimmed keep their full payload. Re-syncing the same bank data
// (a reused ref included) must land on exactly the stored keys: an update, never a new row.
Deno.test("transactions: re-syncing stored rows (full old raw) writes only their stored keys", async () => {
  const party = { name: "Shop", postal_address: { town_name: "Milano" } };
  const a = { ...TX, creditor: party, ultimate_creditor: { name: "Parent" }, creditor_agent: { bic_fi: "B" } };
  const b = { ...a, transaction_amount: { amount: "-9.00", currency: "EUR" } }; // reuses r1
  const first = fakeSupabase();
  await syncAccountTransactions({ fetch: fakeFetch({ "/transactions?": { body: { transactions: [a, b] } } }).fetch, supabase: first.supabase }, "t", account(), "2026-10-20", TODAY);
  const keys = (first.writes[0].data as { entry_reference: string }[]).map((r) => r.entry_reference);
  assertEquals(keys.length, 2);
  // Stored as an older version wrote them: the untrimmed bank payload in raw.
  const stored = [{ entry_reference: keys[0], raw: a }, { entry_reference: keys[1], raw: b }];
  const again = fakeSupabase(null, [], stored);
  await syncAccountTransactions({ fetch: fakeFetch({ "/transactions?": { body: { transactions: [b, a] } } }).fetch, supabase: again.supabase }, "t", account(), "2026-10-20", TODAY);
  assertEquals((again.writes[0].data as { entry_reference: string }[]).map((r) => r.entry_reference).sort(), [...keys].sort());
});

// A first sync can bring thousands of rows: the stored-key lookups run 4 at a time, not one by one.
Deno.test("transactions: stored keys are looked up in chunks of 50, 4 requests at a time", async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ ...TX, entry_reference: `r${i}` }));
  const { fetch } = fakeFetch({ "/transactions?": { body: { transactions: many } } });
  let inFlight = 0;
  let most = 0;
  const lookups: number[] = [];
  const supabase = {
    from: () => ({
      select: () => {
        const query = {
          eq: () => query,
          not: () => query,
          in: (_c: string, keys: string[]) => {
            lookups.push(keys.length);
            inFlight++;
            most = Math.max(most, inFlight);
            return new Promise((resolve) => setTimeout(() => (inFlight--, resolve({ data: [], error: null })), 1));
          },
          then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
        };
        return query;
      },
      upsert: async () => ({ error: null }),
    }),
  };

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), null, TODAY);

  assertEquals(result.upserted, 300);
  assertEquals(lookups, Array(12).fill(50));
  assertEquals(most, 4);
});

Deno.test("transactions: marks rows whose counterparty is one of the user's own accounts", async () => {
  const toOwn = { ...TX, entry_reference: "own", creditor_account: { iban: "IT60 X054 2811 1010 0000 0123 456" } };
  const toOther = { ...TX, entry_reference: "other", creditor_account: { iban: "DE89370400440532013000" } };
  const { fetch } = fakeFetch({ "/transactions?": { body: { transactions: [toOwn, toOther, TX] } } });
  const { supabase, writes } = fakeSupabase(null, [{ iban: "it60x0542811101000000123456" }]);

  await syncAccountTransactions({ fetch, supabase }, "t", account(), null, TODAY);

  const rows = writes[0].data as { entry_reference: string; own_counterparty: boolean | null; raw: object }[];
  assertEquals(rows.map((r) => [r.entry_reference, r.own_counterparty]), [["own", true], ["other", false], ["r1", null]]);
  assert(rows.every((r) => !("creditor_account" in r.raw)));
});

Deno.test("transactions: own accounts unreadable leaves own_counterparty out of the upsert", async () => {
  const { fetch } = fakeFetch({ "/transactions?": { body: { transactions: [TX] } } });
  const { supabase, writes } = fakeSupabase(null);
  const failing = {
    from: (table: string) =>
      table === "accounts"
        ? { select: () => { const q = { eq: () => q, not: () => q, then: (r: (v: unknown) => void) => r({ data: null, error: { code: "57014" } }) }; return q; } }
        : supabase.from(table),
  };
  const errors = console.error;
  console.error = () => {};
  try {
    await syncAccountTransactions({ fetch, supabase: failing }, "t", account(), null, TODAY);
  } finally {
    console.error = errors;
  }
  const [row] = writes[0].data as Record<string, unknown>[];
  assertEquals("own_counterparty" in row, false);
});

Deno.test("transactions: date_from re-reads 7 days before the cursor", async () => {
  const { fetch, urls } = fakeFetch({ "/transactions?": { body: { transactions: [] } } });
  const { supabase, writes } = fakeSupabase();

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-10-20", TODAY);

  assert(urls[0].includes("date_from=2026-10-13"));
  assertEquals(writes, []);
  assertEquals(result.cursor, TODAY); // no new rows still advances the cursor
});

Deno.test("transactions: follows continuation_key across pages", async () => {
  let page = 0;
  const fetch = (async (url: string) => {
    page++;
    const body = page === 1
      ? { transactions: [TX], continuation_key: "k2" }
      : { transactions: [{ ...TX, entry_reference: "r2" }] };
    if (page === 2) assert(url.includes("continuation_key=k2"));
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as Deps["fetch"];
  const { supabase } = fakeSupabase();

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), null, TODAY);

  assertEquals(result.upserted, 2);
});

// H163: a bank answering the same continuation_key again made every run page until the 120 s
// deadline (TIMEOUT, one bank call a page). A repeated key now stops the run at once: the pages
// read are saved and the cursor stays, so nothing is skipped.
Deno.test("transactions: a repeated continuation_key stops paging, saves what came in, keeps the cursor", async () => {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ transactions: [TX], continuation_key: "same" }) };
  }) as unknown as Deps["fetch"];
  const { supabase, writes } = fakeSupabase();
  const silence = console.error;
  console.error = () => {};
  let result;
  try {
    result = await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-10-20", TODAY);
  } finally {
    console.error = silence;
  }

  assertEquals(calls, 2);
  assertEquals(result, { upserted: 1, cursor: null, error: "PAGING_LOOP" });
  assertEquals((writes[0].data as unknown[]).length, 1);
});

Deno.test("transactions: paging stops after 500 pages", async () => {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ transactions: [], continuation_key: `k${calls}` }) };
  }) as unknown as Deps["fetch"];
  const { supabase } = fakeSupabase();
  const silence = console.error;
  console.error = () => {};
  let result;
  try {
    result = await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-10-20", TODAY);
  } finally {
    console.error = silence;
  }

  assertEquals(calls, 500);
  assertEquals(result.error, "PAGING_LOOP");
  assertEquals(result.cursor, null);
});

Deno.test("transactions: a 404 is an error and the cursor stays", async () => {
  const { fetch } = fakeFetch({ "/transactions?": { ok: false, status: 404 } });
  const { supabase, writes } = fakeSupabase();

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-10-20", TODAY);

  assertEquals(result, { upserted: 0, cursor: null, error: "HTTP_404" });
  assertEquals(writes, []);
});

Deno.test("transactions: a failed upsert leaves the cursor", async () => {
  const { fetch } = fakeFetch({ "/transactions?": { body: { transactions: [TX] } } });
  const { supabase } = fakeSupabase({ code: "42501" });

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-10-20", TODAY);

  assertEquals(result, { upserted: 0, cursor: null, error: "SAVE_FAILED" });
});

Deno.test("balance: calls EB with eb_account_uid and builds the row under uid", async () => {
  const { fetch, urls } = fakeFetch({ "/balances": { body: BALANCES } });
  const { supabase } = fakeSupabase();

  const { row, error } = await syncAccountBalance({ fetch, supabase }, "t", account(), TODAY);

  assertEquals(urls, [`${EB}/eb/balances`]);
  assertEquals(row, { account_uid: "pk", currency: "EUR", amount: 12.5, snapshot_date: TODAY, user_id: "user" });
  assertEquals(error, null);
});
Deno.test("balance: saves the booked balance when the bank lists the available one first", async () => {
  const body = { balances: [
    { balance_type: "ITAV", balance_amount: { amount: "1500.00", currency: "EUR" } },
    { balance_type: "CLBD", balance_amount: { amount: "500.00", currency: "EUR" } },
  ] };
  const { fetch } = fakeFetch({ "/balances": { body } });
  const { supabase } = fakeSupabase();

  const { row } = await syncAccountBalance({ fetch, supabase }, "t", account(), TODAY);

  assertEquals(row?.amount, 500);
});


Deno.test("balance: fills a missing hash once, then fetches the balance", async () => {
  const { fetch, urls } = fakeFetch({
    "/details": { body: { identification_hash: "h", account_id: { iban: "IT1" } } },
    "/balances": { body: BALANCES },
  });
  const { supabase, writes } = fakeSupabase();

  const { row } = await syncAccountBalance({ fetch, supabase }, "t", account({ identification_hash: null, account_type: null }), TODAY);

  assertEquals(urls, [`${EB}/eb/details`, `${EB}/eb/balances`]);
  assertEquals(writes, [
    { table: "accounts", op: "update", data: { identification_hash: "h", iban: "IT1", account_type: "checking" }, filters: [["eq", "uid", "pk"]] },
  ]);
  assertEquals(row?.account_uid, "pk");
});

Deno.test("balance: fills a missing account type once from the bank's cash_account_type", async () => {
  const { fetch, urls } = fakeFetch({ "/details": { body: { cash_account_type: "CARD" } }, "/balances": { body: BALANCES } });
  const { supabase, writes } = fakeSupabase();

  await syncAccountBalance({ fetch, supabase }, "t", account({ account_type: null }), TODAY);

  assertEquals(urls, [`${EB}/eb/details`, `${EB}/eb/balances`]);
  assertEquals(writes, [{ table: "accounts", op: "update", data: { account_type: "credit_card" }, filters: [["eq", "uid", "pk"]] }]);
});

Deno.test("balance: a bank that sends no type stores checking, so details is not asked again", async () => {
  const { fetch } = fakeFetch({ "/details": { body: {} }, "/balances": { body: BALANCES } });
  const { supabase, writes } = fakeSupabase();

  await syncAccountBalance({ fetch, supabase }, "t", account({ account_type: null }), TODAY);

  assertEquals(writes, [{ table: "accounts", op: "update", data: { account_type: "checking" }, filters: [["eq", "uid", "pk"]] }]);
});

Deno.test("balance: a typed account with a hash skips details", async () => {
  const { fetch, urls } = fakeFetch({ "/balances": { body: BALANCES } });
  const { supabase, writes } = fakeSupabase();

  await syncAccountBalance({ fetch, supabase }, "t", account({ account_type: "savings" }), TODAY);

  assertEquals(urls, [`${EB}/eb/balances`]);
  assertEquals(writes, []);
});

// H161: a bank whose /details never has an identification_hash was asked again on every run,
// one more unattended call toward its daily limit. /details is asked once, with the type lookup.
Deno.test("balance: a typed account the bank gives no hash for does not ask details again", async () => {
  const { fetch, urls } = fakeFetch({ "/balances": { body: BALANCES } });
  const { supabase, writes } = fakeSupabase();

  await syncAccountBalance({ fetch, supabase }, "t", account({ identification_hash: null, account_type: "checking" }), TODAY);

  assertEquals(urls, [`${EB}/eb/balances`]);
  assertEquals(writes, []);
});

Deno.test("balance: a 429 on details still returns the balance", async () => {
  const { fetch } = fakeFetch({ "/details": { ok: false, status: 429 }, "/balances": { body: BALANCES } });
  const { supabase, writes } = fakeSupabase();

  const { row } = await syncAccountBalance({ fetch, supabase }, "t", account({ identification_hash: null, account_type: null }), TODAY);

  assertEquals(writes, []);
  assert(row);
});

Deno.test("balance: EXPIRED_SESSION marks the consent as ending today (compare-and-set)", async () => {
  const { fetch } = fakeFetch({ "/balances": { ok: false, status: 401, body: EXPIRED } });
  const { supabase, writes } = fakeSupabase();
  const consent = "2027-03-06T00:00:00+00:00";

  const result = await syncAccountBalance({ fetch, supabase }, "t", account({ consent_valid_until: consent }), TODAY);

  assertEquals(writes, [{
    table: "accounts",
    op: "update",
    data: { consent_valid_until: TODAY },
    filters: [["eq", "uid", "pk"], ["eq", "consent_valid_until", consent]],
  }]);
  assertEquals(result, { row: null, renewed: true, ebFailed: true, error: "EXPIRED_SESSION" });
});

Deno.test("balance: a 429 on balances reports ebFailed so the caller stops", async () => {
  const { fetch } = fakeFetch({ "/balances": { ok: false, status: 429 } });
  const { supabase } = fakeSupabase();

  const result = await syncAccountBalance({ fetch, supabase }, "t", account(), TODAY);

  assertEquals(result, { row: null, renewed: false, ebFailed: true, error: "HTTP_429" });
});

Deno.test("balance: EXPIRED_SESSION never moves an earlier consent date later", async () => {
  const { fetch } = fakeFetch({ "/balances": { ok: false, status: 401, body: EXPIRED } });
  const { supabase, writes } = fakeSupabase();
  for (const consent_valid_until of ["2026-10-27T00:00:00+00:00", "2026-10-01T00:00:00+00:00"]) {
    await syncAccountBalance({ fetch, supabase }, "t", account({ consent_valid_until }), TODAY);
  }
  assertEquals(writes, []);
});

Deno.test("balance: a 401 that is not EXPIRED_SESSION, or not JSON, leaves the date alone", async () => {
  for (const body of [{ ...EXPIRED, error: "UNAUTHORIZED" }, { ...EXPIRED, error: "bad text <x>" }, undefined]) {
    const { fetch } = fakeFetch({ "/balances": { ok: false, status: 401, body } });
    const { supabase, writes } = fakeSupabase();
    const result = await syncAccountBalance({ fetch, supabase }, "t", account({ consent_valid_until: null }), TODAY);
    assertEquals(writes, []);
    assertEquals(result.ebFailed, true);
  }
});

Deno.test("transactions: the first sync asks for the longest history the bank keeps", async () => {
  const { fetch, urls } = fakeFetch({ "/transactions?": { body: { transactions: [TX] } } });
  const { supabase } = fakeSupabase();

  await syncAccountTransactions({ fetch, supabase }, "t", account(), null, TODAY);

  const params = new URL(urls[0]).searchParams;
  assertEquals(params.get("strategy"), "longest");
  assertEquals(params.has("date_from"), false);
});

Deno.test("transactions: an empty longest page with a continuation_key keeps paging", async () => {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    const body = urls.length === 1 ? { transactions: [], continuation_key: "k2" } : { transactions: [TX] };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as Deps["fetch"];
  const { supabase } = fakeSupabase();

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), null, TODAY);

  assertEquals(urls.length, 2);
  assertEquals(new URL(urls[1]).searchParams.get("continuation_key"), "k2");
  assertEquals(result.upserted, 1);
});

Deno.test("transactions: later syncs keep the default strategy", async () => {
  const { fetch, urls } = fakeFetch({ "/transactions?": { body: { transactions: [] } } });
  const { supabase } = fakeSupabase();

  await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-10-20", TODAY);

  assertEquals(new URL(urls[0]).searchParams.has("strategy"), false);
});

Deno.test("transactions: WRONG_TRANSACTIONS_PERIOD (cursor older than the bank keeps) retries with longest", async () => {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    if (urls.length === 1) {
      return { ok: false, status: 422, json: async () => ({ error: "WRONG_TRANSACTIONS_PERIOD" }) };
    }
    return { ok: true, status: 200, json: async () => ({ transactions: [TX] }) };
  }) as unknown as Deps["fetch"];
  const { supabase } = fakeSupabase();

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-01-10", TODAY);

  const retry = new URL(urls[1]).searchParams;
  assertEquals(retry.get("strategy"), "longest");
  assertEquals(retry.get("date_from"), "2026-01-03");
  assertEquals(result, { upserted: 1, cursor: TODAY, error: null });
});

Deno.test("transactions: pages fetched before a failure are saved, the cursor stays", async () => {
  let page = 0;
  const fetch = (async () => {
    page++;
    if (page === 1) return { ok: true, status: 200, json: async () => ({ transactions: [TX], continuation_key: "k2" }) };
    return { ok: false, status: 429, json: async () => ({ error: "ASPSP_RATE_LIMIT_EXCEEDED" }) };
  }) as unknown as Deps["fetch"];
  const { supabase, writes } = fakeSupabase();

  const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), null, TODAY);

  assertEquals(writes.length, 1);
  assertEquals(result, { upserted: 1, cursor: null, error: "ASPSP_RATE_LIMIT_EXCEEDED" });
});

Deno.test("transactions: a network failure reports NETWORK, a timeout TIMEOUT", async () => {
  for (const [thrown, code] of [[new TypeError("fetch failed"), "NETWORK"], [new DOMException("t", "TimeoutError"), "TIMEOUT"]] as const) {
    const fetch = (async () => {
      throw thrown;
    }) as unknown as Deps["fetch"];
    const { supabase } = fakeSupabase();
    const result = await syncAccountTransactions({ fetch, supabase }, "t", account(), "2026-10-20", TODAY);
    assertEquals(result.error, code);
  }
});

Deno.test("balance: a revoked or closed consent is marked for renewal like an expired one", async () => {
  for (const error of ["REVOKED_SESSION", "CLOSED_SESSION"]) {
    const { fetch } = fakeFetch({ "/balances": { ok: false, status: 401, body: { ...EXPIRED, error } } });
    const { supabase, writes } = fakeSupabase();
    const consent = "2027-03-06T00:00:00+00:00";

    const result = await syncAccountBalance({ fetch, supabase }, "t", account({ consent_valid_until: consent }), TODAY);

    assertEquals(writes.length, 1);
    assertEquals(writes[0].data, { consent_valid_until: TODAY });
    assertEquals(result.renewed, true);
    assertEquals(result.error, error);
  }
});

Deno.test("balance: a saved balance reports no error", async () => {
  const { fetch } = fakeFetch({ "/balances": { body: BALANCES } });
  const { supabase } = fakeSupabase();

  const result = await syncAccountBalance({ fetch, supabase }, "t", account(), TODAY);

  assertEquals(result.error, null);
});

Deno.test("syncErrorPatch: stores a new error with its time, clears it on success, skips no change", () => {
  const at = "2026-11-17T10:00:00.000Z";
  assertEquals(syncErrorPatch(account(), "ASPSP_TIMEOUT", at), { sync_error: "ASPSP_TIMEOUT", sync_error_at: at });
  assertEquals(syncErrorPatch(account({ sync_error: "ASPSP_TIMEOUT" }), null, at), { sync_error: null, sync_error_at: null });
  assertEquals(syncErrorPatch(account({ sync_error: "ASPSP_TIMEOUT" }), "ASPSP_TIMEOUT", at), null);
  assertEquals(syncErrorPatch(account(), null, at), null);
});

Deno.test("syncStatus: 200 synced, 429 for the bank's daily limit, 502 for other failures", () => {
  assertEquals(syncStatus("2026-11-17", null), 200);
  assertEquals(syncStatus(null, "ASPSP_RATE_LIMIT_EXCEEDED"), 429);
  assertEquals(syncStatus(null, "ASPSP_ERROR"), 502);
});

// Polish 1 #2: a first sync that ran out of time restarts longest from page 1 every run (the
// continuation key dies with the run), spending the bank's daily calls forever on a long history.
Deno.test("transactions: a first sync that timed out falls back to the last 90 days", async () => {
  const { fetch, urls } = fakeFetch({ "/transactions?": { body: { transactions: [TX] } } });
  const { supabase } = fakeSupabase();

  await syncAccountTransactions({ fetch, supabase }, "t", account({ sync_error: "TIMEOUT" }), null, TODAY);

  const params = new URL(urls[0]).searchParams;
  assertEquals(params.has("strategy"), false);
  assertEquals(params.get("date_from"), "2026-07-29"); // TODAY 2026-10-27 minus 90 days
});

// H163 review: a first sync stopped by PAGING_LOOP (500 pages of a long history, or a bank that
// repeats its key on longest) would ask for longest again every run and never set a cursor.
Deno.test("transactions: a first sync stopped by PAGING_LOOP falls back to the last 90 days", async () => {
  const { fetch, urls } = fakeFetch({ "/transactions?": { body: { transactions: [TX] } } });
  const { supabase } = fakeSupabase();

  await syncAccountTransactions({ fetch, supabase }, "t", account({ sync_error: "PAGING_LOOP" }), null, TODAY);

  const params = new URL(urls[0]).searchParams;
  assertEquals(params.has("strategy"), false);
  assertEquals(params.get("date_from"), "2026-07-29");
});

Deno.test("transactions: a first sync after another error still asks for the longest history", async () => {
  const { fetch, urls } = fakeFetch({ "/transactions?": { body: { transactions: [] } } });
  const { supabase } = fakeSupabase();

  await syncAccountTransactions({ fetch, supabase }, "t", account({ sync_error: "ASPSP_ERROR" }), null, TODAY);

  assertEquals(new URL(urls[0]).searchParams.get("strategy"), "longest");
});

Deno.test("balance: an error name over 64 letters is not stored, the HTTP status is", async () => {
  for (const [name, expected] of [["A".repeat(64), "A".repeat(64)], ["A".repeat(65), "HTTP_502"]]) {
    const { fetch } = fakeFetch({ "/balances": { ok: false, status: 502, body: { error: name } } });
    const { supabase } = fakeSupabase();
    const result = await syncAccountBalance({ fetch, supabase }, "t", account(), TODAY);
    assertEquals(result.error, expected);
  }
});

// Polish 5 F1: sync-bank's last step, run on the account row itself.
Deno.test("recordSyncError: the balance error wins, is saved on the account and returned", async () => {
  const db = memoryDb({ accounts: [{ uid: "pk", sync_error: null, sync_error_at: null }] });
  const at = "2026-11-17T06:17:00.000Z";
  assertEquals(await recordSyncError(db, account({ sync_error: null }), "HTTP_401", "ASPSP_TIMEOUT", at), "HTTP_401");
  assertEquals(db.tables.accounts[0], { uid: "pk", sync_error: "HTTP_401", sync_error_at: at });
});
Deno.test("recordSyncError: a transactions error is saved when the balance went through", async () => {
  const db = memoryDb({ accounts: [{ uid: "pk", sync_error: null, sync_error_at: null }] });
  assertEquals(await recordSyncError(db, account({ sync_error: null }), null, "SAVE_FAILED", "t"), "SAVE_FAILED");
  assertEquals(db.tables.accounts[0].sync_error, "SAVE_FAILED");
});
Deno.test("recordSyncError: a good run clears the stored error", async () => {
  const db = memoryDb({ accounts: [{ uid: "pk", sync_error: "HTTP_500", sync_error_at: "t0" }] });
  assertEquals(await recordSyncError(db, account({ sync_error: "HTTP_500" }), null, null, "t"), null);
  assertEquals(db.tables.accounts[0], { uid: "pk", sync_error: null, sync_error_at: null });
});
Deno.test("recordSyncError: a failed write never fails the sync", async () => {
  const db = memoryDb({ accounts: [{ uid: "pk", sync_error: null }] }, "update");
  assertEquals(await quietly(() => recordSyncError(db, account({ sync_error: null }), "HTTP_401", null, "t")), "HTTP_401");
});
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

// H039: a missing or broken Enable Banking key used to throw before any sync_error was saved,
// so the account just went stale with no message on the dashboard.
Deno.test("signOrRecord: a key that can't sign is recorded on the account as KEY_INVALID", async () => {
  const db = memoryDb({ accounts: [{ uid: "pk", sync_error: null, sync_error_at: null }] });
  const token = await quietly(() => signOrRecord(db, account({ sync_error: null }), () => Promise.reject(new Error("bad pem")), "t"));
  assertEquals(token, null);
  assertEquals(db.tables.accounts[0], { uid: "pk", sync_error: "KEY_INVALID", sync_error_at: "t" });
});
Deno.test("signOrRecord: a good key returns the token and leaves the account alone", async () => {
  const db = memoryDb({ accounts: [{ uid: "pk", sync_error: null, sync_error_at: null }] });
  assertEquals(await signOrRecord(db, account({ sync_error: null }), () => Promise.resolve("jwt"), "t"), "jwt");
  assertEquals(db.tables.accounts[0].sync_error, null);
});
