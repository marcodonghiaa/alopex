import { assertEquals } from "jsr:@std/assert@1.0.19";
import { refreshHandler } from "./handler.ts";
import { memoryDb } from "../_shared/memory-db.test-helper.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const DATES = ["2026-07-05", "2026-08-04", "2026-09-03", "2026-10-03"];
const seed = () =>
  memoryDb({
    accounts: [{ user_id: "u1" }, { user_id: "u2" }],
    transactions: ["u1", "u2"].flatMap((u) =>
      DATES.map((d, i) => ({
        user_id: u, account_uid: `a-${u}`, entry_reference: `${u}${i}`, merchant_key: "zorblax", currency: "EUR",
        amount: 20, booking_date: d, category: "Entertainment", custom_name: null, creditor_name: "Zorblax",
        bank_transaction_code: null, flow_type: "spend", credit_debit_indicator: "DBIT", deleted_at: null,
        transaction_type: "Subscription",
      }))
    ),
    v_transactions_eur: [],
  });

// The rate limit's read (select detected_at) fails; every other read works.
const failingLimitRead = (db: ReturnType<typeof seed>, how: "error" | "throw") => ({
  ...db,
  from(table: string) {
    const q = db.from(table);
    if (table !== "recurring_detection_runs") return q;
    // deno-lint-ignore no-explicit-any
    const fail: any = new Proxy({}, {
      get: (_, k) =>
        k === "then"
          ? (r: (v: unknown) => void, j: (e: unknown) => void) =>
            how === "throw" ? j(new Error("fetch failed")) : r({ data: null, error: { code: "XX000" } })
          : () => fail,
    });
    return { ...q, select: (cols: string) => cols === "last_run_at" ? fail : q.select() };
  },
});

type Call = { p_user: string; p_rows: unknown[] };
const call = async (
  init: RequestInit & { headers?: Record<string, string> } = {},
  opts: {
    mfa?: { body: object; status: number } | null;
    rpcFails?: boolean;
    authDown?: boolean;
    mfaDown?: boolean;
    db?: ReturnType<typeof seed>; // shared across calls, so a run's time is seen by the next one
    now?: number; // ms; the clock of this call
    limitReadFails?: "error" | "throw";
  } = {},
) => {
  const calls: Call[] = [];
  const now = opts.now ?? Date.parse("2026-10-20T10:00:00Z");
  const db = opts.db ?? seed();
  const handler = refreshHandler({
    userIdFor: (a) => opts.authDown ? Promise.reject(new Error("down")) : Promise.resolve(a === "Bearer good" ? "u1" : null),
    mfaRefusal: () => opts.mfaDown ? Promise.reject(new Error("down")) : Promise.resolve(opts.mfa ?? null),
    admin: () => opts.limitReadFails ? failingLimitRead(db, opts.limitReadFails) : db,
    rpc: (_fn, args) => {
      if (opts.rpcFails) return Promise.resolve({ data: null, error: { code: "XX000" } });
      calls.push(args as Call);
      // Like upsert_detected_streams: every call records the user's run time, rows or not.
      const user = (args as Call).p_user;
      const runs = (db.tables.recurring_detection_runs ??= []);
      const run = runs.find((x) => x.user_id === user);
      if (run) run.last_run_at = new Date(now).toISOString();
      else runs.push({ user_id: user, last_run_at: new Date(now).toISOString() });
      return Promise.resolve({ data: 1, error: null });
    },
    today: () => "2026-10-20",
    now: () => now,
  });
  const res = await handler(
    new Request("http://x/refresh-recurring", { method: "POST", headers: { Authorization: "Bearer good" }, ...init }),
    json,
  );
  return { status: res.status, body: await res.json(), calls };
};

Deno.test("only POST", async () => {
  assertEquals((await call({ method: "GET" })).status, 405);
});

Deno.test("no or bad token: 401, nothing detected", async () => {
  for (const headers of [{}, { Authorization: "Bearer bad" }] as Record<string, string>[]) {
    const res = await call({ headers });
    assertEquals([res.status, res.calls], [401, []]);
  }
});

Deno.test("auth unreachable: 503", async () => {
  assertEquals((await call({}, { authDown: true })).status, 503);
});

// Polish 1 #4: the 503 when the two-step check can't be reached had no test.
Deno.test("two-step check unreachable: 503, nothing detected", async () => {
  const res = await call({}, { mfaDown: true });
  assertEquals([res.status, res.calls], [503, []]);
});

Deno.test("two-step sign-in missing: the refusal is passed on, nothing detected", async () => {
  const res = await call({}, { mfa: { body: { error: "mfa" }, status: 403 } });
  assertEquals([res.status, res.body, res.calls], [403, { error: "mfa" }, []]);
});

// protects=one user's refresh never rewrites another user's subscriptions
Deno.test("refreshes only the caller's streams", async () => {
  const res = await call();
  assertEquals([res.status, res.body], [200, { streams: 1 }]);
  assertEquals(res.calls.map((c) => c.p_user), ["u1"]);
});

Deno.test("a failed save is a 500 with a plain error", async () => {
  const res = await call({}, { rpcFails: true });
  assertEquals([res.status, res.body], [500, { error: "Couldn't refresh your subscriptions, please try again" }]);
});

// S2 (polish 2): every Subscriptions page open ran a full detection; nothing limited how often.
const T0 = Date.parse("2026-10-20T10:00:00Z");
Deno.test("S2: a second call within 5 s is a 429 and detects nothing", async () => {
  const db = seed();
  assertEquals((await call({}, { db, now: T0 })).status, 200);
  const again = await call({}, { db, now: T0 + 4999 });
  assertEquals([again.status, again.calls], [429, []]);
  assertEquals(typeof again.body.error, "string");
});

Deno.test("S2: a call 5 s after the last run detects again", async () => {
  const db = seed();
  await call({}, { db, now: T0 });
  const later = await call({}, { db, now: T0 + 5000 });
  assertEquals([later.status, later.calls.length], [200, 1]);
});

Deno.test("S2: another user's recent run does not limit you", async () => {
  const db = seed();
  db.tables.recurring_detection_runs = [{ user_id: "u2", last_run_at: new Date(T0).toISOString() }];
  const res = await call({}, { db, now: T0 + 1 });
  assertEquals([res.status, res.calls.length], [200, 1]);
});

// S2b (re-audit): the limit read max(detected_at), which never moves for these two users.
const twice = async (db: ReturnType<typeof seed>) => {
  const first = await call({}, { db, now: T0 });
  const again = await call({}, { db, now: T0 + 4999 });
  return [first.status, first.calls.length, again.status, again.calls.length];
};

Deno.test("S2b: a user whose charges make no streams gets a 429 on a second call within 5 s", async () => {
  const db = memoryDb({ accounts: [{ user_id: "u1" }], transactions: [], v_transactions_eur: [] });
  assertEquals(await twice(db), [200, 1, 429, 0]);
  assertEquals(db.tables.recurring_streams ?? [], []);
});

Deno.test("S2b: a user whose streams are all gone gets a 429 on a second call within 5 s", async () => {
  const db = memoryDb({
    accounts: [{ user_id: "u1" }], transactions: [], v_transactions_eur: [],
    recurring_streams: [{ user_id: "u1", stream_key: "k", user_status: "confirmed", detected_status: "gone", detected_at: "2026-01-01T00:00:00Z" }],
  });
  assertEquals(await twice(db), [200, 1, 429, 0]);
});

Deno.test("S2: if the last-run read fails, detection still runs (the limit fails open)", async () => {
  const db = seed();
  db.tables.recurring_detection_runs = [{ user_id: "u1", last_run_at: new Date(T0).toISOString() }];
  for (const how of ["error", "throw"] as const) {
    const res = await call({}, { db, now: T0 + 1, limitReadFails: how });
    assertEquals([res.status, res.calls.length], [200, 1], how);
  }
});
