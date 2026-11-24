import { assertEquals } from "jsr:@std/assert@1.0.19";
import { memoryDb } from "./memory-db.test-helper.ts";
import { SplitwiseApiError, SplitwiseAuthError, SplitwiseProRequiredError, SplitwiseRateLimitError, type SwExpense, type SwGroup } from "./splitwise-api.ts";
import { type Connection, type JobDeps, needsFullCheck, runAllUsers, syncNowHandler, syncUser } from "./splitwise-sync-job.ts";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const DAY = 86_400_000;
// A stored connection row: status is the table's (the cron filters on it), not read by the job.
type Row = Connection & { status: string };
const conn = (over: Partial<Row> = {}): Row => ({
  user_id: "u1",
  splitwise_user_id: 1,
  status: "ok",
  cursor_updated_at: "2026-11-15T00:00:00Z",
  last_full_check_at: "2026-11-14T00:00:00Z",
  last_synced_at: "2026-11-17T06:00:00Z",
  ...over,
});
const expense = (id: number, over: Partial<SwExpense> = {}): SwExpense => ({
  id,
  group_id: 5,
  description: `E${id}`,
  cost: "10.00",
  currency_code: "EUR",
  date: "2026-11-10T12:00:00Z",
  updated_at: "2026-11-16T08:00:00Z",
  users: [{ user_id: 1, paid_share: "0", owed_share: "5.00" }, { user_id: 2, paid_share: "10.00", owed_share: "5.00" }],
  ...over,
});
const groups: SwGroup[] = [{
  id: 5,
  name: "Flat",
  members: [{ id: 1, first_name: "Ann", balance: [{ currency_code: "EUR", amount: "-5.00" }] }, { id: 2, first_name: "Bo" }],
  original_debts: [{ from: 1, to: 2, amount: "5.00", currency_code: "EUR" }],
}];

type RpcCall = { fn: string; args: Record<string, unknown> };
function setup(opts: {
  connections?: Connection[];
  expenses?: SwExpense[] | Error;
  key?: string | null;
  apply?: (args: Record<string, unknown>) => { data: unknown; error: unknown };
  tables?: Record<string, Record<string, unknown>[]>;
  attemptError?: unknown;
  /** get_expense answers by id for the full check's re-read: absent or null is a 404. */
  reread?: Record<number, SwExpense | null | Error>;
} = {}) {
  const db = memoryDb({ splitwise_connections: (opts.connections ?? [conn()]).map((c) => ({ ...c })), ...opts.tables });
  const calls: RpcCall[] = [];
  const asked: Array<{ key: string; updatedAfter?: string }> = [];
  const reread: number[] = [];
  const deps: JobDeps = {
    db,
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (fn === "splitwise_read_key") return Promise.resolve({ data: opts.key === undefined ? "k" : opts.key, error: null });
      if (fn === "splitwise_attempt") { // as the SQL: at most p_max per user and kind (here, ever)
        if (opts.attemptError) return Promise.resolve({ data: null, error: opts.attemptError });
        const same = calls.filter((c) => c.fn === fn && c.args.p_user === args.p_user && c.args.p_kind === args.p_kind);
        return Promise.resolve({ data: same.length <= (args.p_max as number), error: null });
      }
      const a = args as { p_shares: unknown[]; p_review: unknown[]; p_deleted: unknown[] };
      return Promise.resolve(opts.apply?.(args) ?? {
        data: { new: a.p_shares.length, adopted: 0, review: a.p_review.length, deleted: a.p_deleted.length },
        error: null,
      });
    },
    client: (key) => ({
      expenses: ({ updatedAfter } = {}) => {
        asked.push({ key, updatedAfter });
        return opts.expenses instanceof Error ? Promise.reject(opts.expenses) : Promise.resolve(opts.expenses ?? [expense(1)]);
      },
      groups: () => Promise.resolve(groups),
      expense: (id) => {
        reread.push(id);
        const r = opts.reread?.[id] ?? null;
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
    }),
    now: () => NOW,
  };
  const applies = () => calls.filter((c) => c.fn === "splitwise_sync_apply").map((c) => c.args);
  return { db, deps, calls, asked, applies, reread };
}

Deno.test("needsFullCheck: first sync, never checked, or a week since", () => {
  assertEquals(needsFullCheck(conn(), NOW), false);
  assertEquals(needsFullCheck(conn({ cursor_updated_at: null }), NOW), true);
  assertEquals(needsFullCheck(conn({ last_full_check_at: null }), NOW), true);
  assertEquals(needsFullCheck(conn({ last_full_check_at: new Date(NOW - 7 * DAY - 1).toISOString() }), NOW), true);
  assertEquals(needsFullCheck(conn({ last_full_check_at: new Date(NOW - 6 * DAY).toISOString() }), NOW), false);
});

Deno.test("an incremental sync reads changes since the cursor minus a day and writes once", async () => {
  const s = setup({ expenses: [expense(1), expense(2, { deleted_at: "2026-11-16T08:00:00Z" })] });
  const counts = await syncUser(s.deps, conn(), { preview: false });
  assertEquals(counts, { new: 1, adopted: 0, review: 0, deleted: 1, skipped: 0, full: false });
  assertEquals(s.asked, [{ key: "k", updatedAfter: "2026-11-14T00:00:00.000Z" }]);
  const [args] = s.applies();
  assertEquals(args.p_user, "u1");
  assertEquals((args.p_shares as Array<{ amount: string }>).map((r) => r.amount), ["5.00"]);
  assertEquals(args.p_deleted, [2]);
  assertEquals(args.p_cursor, "2026-11-16T08:00:00.000Z");
  assertEquals([args.p_full, args.p_preview], [false, false]);
  assertEquals(args.p_balances, [
    { group_name: "Flat", person: "Ann", balance: "-5.00", currency: "EUR", is_me: true },
    { group_name: "Flat", person: "Bo", balance: "5.00", currency: "EUR", is_me: false },
  ]);
});

Deno.test("a full check reads everything and removes what Splitwise no longer has", async () => {
  const s = setup({
    expenses: [expense(1)],
    tables: {
      splitwise_expenses: [{ user_id: "u1", splitwise_id: 1 }, { user_id: "u1", splitwise_id: 7 }, { user_id: "u1", splitwise_id: null }, { user_id: "u2", splitwise_id: 8 }],
      splitwise_review: [{ user_id: "u1", splitwise_id: 9 }],
    },
  });
  const counts = await syncUser(s.deps, conn({ last_full_check_at: null }), { preview: true });
  assertEquals(counts.full, true);
  assertEquals(s.asked, [{ key: "k", updatedAfter: undefined }]);
  const [args] = s.applies();
  assertEquals((args.p_deleted as number[]).sort(), [7, 9]);
  assertEquals([args.p_full, args.p_preview], [true, true]);
});

// polish-1 #5: a full read that comes back far shorter than what is stored removes nothing.
// Round 2 (N1): it must not stop the sync either: the rest is written, the full check counts as
// done, and the connection says why nothing was removed.
Deno.test("a full check that would remove most of what is stored holds the removals, syncs the rest, and says so", async () => {
  const stored = Array.from({ length: 30 }, (_, i) => ({ user_id: "u1", splitwise_id: i + 1 }));
  const s = setup({
    connections: [conn({ last_full_check_at: null })],
    expenses: [expense(1), expense(2), expense(40, { deleted_at: "2026-11-16T00:00:00Z" })],
    tables: { splitwise_expenses: stored, splitwise_review: [] },
  });
  const counts = await syncUser(s.deps, conn({ last_full_check_at: null }), { preview: false });
  const [args] = s.applies();
  assertEquals([(args.p_shares as unknown[]).length, args.p_deleted, args.p_full], [2, [40], true]);
  assertEquals(counts.held, 28);
  const row = s.db.tables.splitwise_connections[0];
  assertEquals([row.status, row.last_error], ["error", "Splitwise sent far fewer expenses than Alopex has, so 28 were not removed"]);
  // A dry run says the same in its counts and writes nothing.
  const p = setup({ tables: { splitwise_expenses: stored, splitwise_review: [] }, expenses: [expense(1)] });
  assertEquals((await syncUser(p.deps, conn({ last_full_check_at: null }), { preview: true })).held, 29);
  assertEquals(p.db.tables.splitwise_connections[0].status, "ok");
  // Up to 10, or up to half, still go.
  const few = setup({ expenses: Array.from({ length: 15 }, (_, i) => expense(i + 1)), tables: { splitwise_expenses: stored, splitwise_review: [] } });
  const [fewArgs] = await syncUser(few.deps, conn({ last_full_check_at: null }), { preview: false }).then(() => few.applies());
  assertEquals((fewArgs.p_deleted as number[]).length, 15);
});

Deno.test("big runs are written in chunks; balances, cursor and full only with the last", async () => {
  const many = Array.from({ length: 5001 }, (_, i) => expense(i + 1));
  const s = setup({ expenses: many });
  const counts = await syncUser(s.deps, conn({ cursor_updated_at: null }), { preview: false });
  const applies = s.applies();
  assertEquals(applies.map((a) => (a.p_shares as unknown[]).length), [5000, 1]);
  assertEquals(applies.map((a) => a.p_balances === null), [true, false]);
  assertEquals(applies.map((a) => a.p_cursor), [null, "2026-11-16T08:00:00.000Z"]);
  assertEquals(applies.map((a) => a.p_full), [false, true]);
  assertEquals(counts.new, 5001);
});

Deno.test("no key stored is an auth error; a database error is thrown", async () => {
  const s = setup({ key: null });
  let err: unknown = null;
  await syncUser(s.deps, conn(), { preview: false }).catch((e) => (err = e));
  assertEquals(err instanceof SplitwiseAuthError, true);
  const s2 = setup({ apply: () => ({ data: null, error: { code: "P0001", message: "Too many rows" } }) });
  err = null;
  await syncUser(s2.deps, conn(), { preview: false }).catch((e) => (err = e));
  assertEquals((err as { code: string }).code, "P0001");
});

Deno.test("cron: every ok or failed connection, one failure doesn't stop the others", async () => {
  let n = 0;
  const s = setup({
    connections: [conn({ user_id: "u1" }), conn({ user_id: "u2", status: "error" }), conn({ user_id: "u3", status: "needs_reconnect" })],
    apply: (args) => (args.p_user === "u1" && n++ === 0 ? { data: null, error: { code: "XX000" } } : { data: { new: 1, adopted: 0, review: 0, deleted: 0 }, error: null }),
  });
  const result = await runAllUsers(s.deps, () => true);
  assertEquals(result, { users: 1, failed: 1, needsReconnect: 0, skipped: 0, rateLimited: false, new: 1, adopted: 0, review: 0, deleted: 0 });
  assertEquals(s.db.tables.splitwise_connections.map((c) => [c.user_id, c.status, c.last_error]), [
    ["u1", "error", "Sync failed (XX000)"],
    ["u2", "error", undefined],
    ["u3", "needs_reconnect", undefined],
  ]);
});

Deno.test("cron: a refused key asks to reconnect; a rate limit stops the run and keeps the status", async () => {
  const s = setup({ expenses: new SplitwiseAuthError("Splitwise refused the API key", 401) });
  assertEquals((await runAllUsers(s.deps, () => true)).needsReconnect, 1);
  assertEquals(s.db.tables.splitwise_connections[0].status, "needs_reconnect");

  const r = setup({
    connections: [conn({ user_id: "u1" }), conn({ user_id: "u2" })],
    expenses: new SplitwiseRateLimitError("slow", 429),
  });
  const result = await runAllUsers(r.deps, () => true);
  assertEquals([result.rateLimited, result.skipped, result.failed], [true, 1, 0]);
  assertEquals(r.asked.length, 1);
  assertEquals(r.db.tables.splitwise_connections.map((c) => c.status), ["ok", "ok"]);
});

// Splitwise Pro: the key's account has no Pro (403 naming Pro), or a key that worked is now
// refused (401), which is also what Splitwise answers once a Pro subscription ends.
const PRO = "Splitwise needs an active Splitwise Pro subscription for API keys. Renew it and connect again, or import a Splitwise file.";
const REFUSED = "Splitwise refused the API key, or your Splitwise Pro subscription ended. Connect again, or import a Splitwise file.";

Deno.test("cron: no Splitwise Pro is its own state, skipped like a refused key; a 401 may mean Pro ended", async () => {
  const pro = setup({ expenses: new SplitwiseProRequiredError("Splitwise Pro is required for API keys", 403) });
  assertEquals((await runAllUsers(pro.deps, () => true)).needsReconnect, 1);
  assertEquals([pro.db.tables.splitwise_connections[0].status, pro.db.tables.splitwise_connections[0].last_error], ["pro_required", PRO]);
  assertEquals((await runAllUsers(pro.deps, () => true)).users, 0, "not tried again until the user connects");
  const refused = setup({ expenses: new SplitwiseAuthError("Splitwise refused the API key", 401) });
  await runAllUsers(refused.deps, () => true);
  assertEquals([refused.db.tables.splitwise_connections[0].status, refused.db.tables.splitwise_connections[0].last_error], ["needs_reconnect", REFUSED]);
});

Deno.test("handler: Sync now and its preview answer pro_required with what to do", async () => {
  for (const preview of [false, true]) {
    const s = setup({ connections: [conn()], expenses: new SplitwiseProRequiredError("x", 403) });
    const res = await call(handler(s), user(preview ? { preview: true } : {}));
    assertEquals([res.status, res.body.code, res.body.error], [409, "pro_required", PRO]);
    assertEquals(s.db.tables.splitwise_connections[0].status, "pro_required");
  }
  const s = setup({ connections: [conn()], expenses: new SplitwiseAuthError("x", 401) });
  assertEquals((await call(handler(s), user({}))).body.error, REFUSED);
});

Deno.test("cron: an API error keeps its safe message; out of time leaves the rest for next run", async () => {
  const s = setup({ expenses: new SplitwiseApiError("Splitwise answered HTTP 503", 503) });
  await runAllUsers(s.deps, () => true);
  assertEquals(s.db.tables.splitwise_connections[0].last_error, "Splitwise answered HTTP 503");
  const t = setup({ connections: [conn({ user_id: "u1" }), conn({ user_id: "u2" })] });
  assertEquals((await runAllUsers(t.deps, () => false)).skipped, 2);
  assertEquals(t.applies().length, 0);
});

Deno.test("cron: the connection list can't be read → one failure, nothing synced", async () => {
  const s = setup();
  const failed = { limit: () => Promise.resolve({ data: null, error: { code: "57014" } }) };
  const broken = { from: () => ({ select: () => ({ in: () => ({ order: () => ({ order: () => failed }) }) }) }) };
  assertEquals((await runAllUsers({ ...s.deps, db: broken }, () => true)).failed, 1);
});

// ---- The HTTP handler ----

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function handler(s: ReturnType<typeof setup>, over: Partial<Parameters<typeof syncNowHandler>[0]> = {}) {
  return syncNowHandler({
    ...s.deps,
    isServer: (req) => req.headers.get("apikey") === "sb_secret",
    userIdFor: (a) => Promise.resolve(a === "Bearer good" ? "u1" : a === "Bearer other" ? "u9" : null),
    mfaRefusal: () => Promise.resolve(null),
    timeLeft: () => true,
    ...over,
  });
}
const call = async (h: ReturnType<typeof handler>, init: RequestInit) => {
  const res = await h(new Request("http://x/sync-splitwise", { method: "POST", ...init }), json);
  return { status: res.status, body: await res.json() };
};
const user = (body?: unknown, auth = "Bearer good") => ({ headers: { Authorization: auth }, body: body === undefined ? undefined : JSON.stringify(body) });

Deno.test("handler: only POST; the cron with the secret key syncs everyone", async () => {
  const s = setup();
  assertEquals((await call(handler(s), { method: "GET" })).status, 405);
  const res = await call(handler(s), { headers: { apikey: "sb_secret" } });
  assertEquals([res.status, res.body.users], [200, 1]);
  const f = setup({ apply: () => ({ data: null, error: { code: "XX000" } }) });
  assertEquals((await call(handler(f), { headers: { apikey: "sb_secret" } })).status, 500);
});

Deno.test("handler: a user must be signed in and past two-step sign-in", async () => {
  const s = setup();
  assertEquals((await call(handler(s), {})).status, 401);
  assertEquals((await call(handler(s), user({}, "Bearer bad"))).status, 401);
  const down = handler(s, { userIdFor: () => Promise.reject(new Error("auth down")) });
  assertEquals((await call(down, user({}))).status, 503);
  const mfa = handler(s, { mfaRefusal: () => Promise.resolve({ body: { code: "mfa_required" }, status: 403 }) });
  assertEquals(await call(mfa, user({})), { status: 403, body: { code: "mfa_required" } });
  const mfaDown = handler(s, { mfaRefusal: () => Promise.reject(new Error("x")) });
  assertEquals((await call(mfaDown, user({}))).status, 503);
});

Deno.test("handler: Sync now syncs only the caller's connection", async () => {
  const s = setup({ connections: [conn({ user_id: "u1", last_synced_at: null }), conn({ user_id: "u2" })] });
  const res = await call(handler(s), user({}));
  assertEquals(res, { status: 200, body: { new: 1, adopted: 0, review: 0, deleted: 0, skipped: 0, full: false } });
  assertEquals(s.applies().map((a) => a.p_user), ["u1"]);
  assertEquals((await call(handler(s), user({}, "Bearer other"))).status, 404);
});

// polish-2 #1: each Sync now and each preview claims its once-a-minute attempt before any work, so a
// failed run, a preview or parallel calls cannot reach Splitwise more often (the SQL test runs them in parallel).
Deno.test("handler: Sync now and preview each take their once-a-minute attempt before any work", async () => {
  const s = setup({ connections: [conn({ last_synced_at: null })] });
  assertEquals((await call(handler(s), user({}))).status, 200);
  const again = await call(handler(s), user({}));
  assertEquals([again.status, again.body.error], [429, "Synced a moment ago. Try again in a minute."]);
  assertEquals((await call(handler(s), user({ preview: true }))).status, 200); // its own allowance
  assertEquals((await call(handler(s), user({ preview: true }))).status, 429);
  assertEquals(s.asked.length, 2);
  assertEquals(s.applies().map((a) => a.p_preview), [false, true]);
  assertEquals(s.calls.filter((c) => c.fn === "splitwise_attempt").map((c) => c.args),
    [{ p_user: "u1", p_kind: "sync", p_max: 1, p_window: "1 minute" }, { p_user: "u1", p_kind: "sync", p_max: 1, p_window: "1 minute" },
     { p_user: "u1", p_kind: "preview", p_max: 1, p_window: "1 minute" }, { p_user: "u1", p_kind: "preview", p_max: 1, p_window: "1 minute" }]);
  // A failed sync used its attempt too.
  const failed = setup({ connections: [conn({ last_synced_at: null })], expenses: new TypeError("network") });
  assertEquals((await call(handler(failed), user({}))).status, 502);
  assertEquals((await call(handler(failed), user({}))).status, 429);
  assertEquals(failed.asked.length, 1);
  // The check itself failing stops the sync too.
  const down = setup({ attemptError: { code: "57014" } });
  assertEquals((await call(handler(down), user({}))).status, 502);
  assertEquals(down.asked.length, 0);
});

Deno.test("handler: a refused key, a rate limit and other failures each say what to do", async () => {
  const auth = setup({ connections: [conn({ last_synced_at: null })], expenses: new SplitwiseAuthError("x", 401) });
  const a = await call(handler(auth), user({}));
  assertEquals([a.status, a.body.code], [409, "needs_reconnect"]);
  assertEquals(auth.db.tables.splitwise_connections[0].status, "needs_reconnect");
  const rate = setup({ connections: [conn({ last_synced_at: null })], expenses: new SplitwiseRateLimitError("x", 429) });
  assertEquals((await call(handler(rate), user({}))).status, 429);
  assertEquals(rate.db.tables.splitwise_connections[0].status, "ok");
  const other = setup({ connections: [conn({ last_synced_at: null })], expenses: new TypeError("network") });
  const o = await call(handler(other), user({}));
  assertEquals([o.status, o.body.error], [502, "Couldn't sync with Splitwise. Try again later."]);
  assertEquals(other.db.tables.splitwise_connections[0].last_error, "Sync failed (TypeError)");
});

// polish-1 #16: a dry run that fails changes nothing, the connection's status included; a refused
// key still asks to reconnect (it would fail the real sync too).
Deno.test("handler: a failed preview keeps the status, except a refused key", async () => {
  const s = setup({ connections: [conn()], expenses: new SplitwiseApiError("Splitwise answered HTTP 500", 500) });
  const res = await call(handler(s), user({ preview: true }));
  assertEquals(res.status, 502);
  assertEquals([s.db.tables.splitwise_connections[0].status, s.db.tables.splitwise_connections[0].last_error ?? null], ["ok", null]);
  const auth = setup({ connections: [conn()], expenses: new SplitwiseAuthError("x", 401) });
  assertEquals((await call(handler(auth), user({ preview: true }))).body.code, "needs_reconnect");
  assertEquals(auth.db.tables.splitwise_connections[0].status, "needs_reconnect");
  const real = setup({ connections: [conn({ last_synced_at: null })], expenses: new SplitwiseApiError("Splitwise answered HTTP 500", 500) });
  await call(handler(real), user({}));
  assertEquals(real.db.tables.splitwise_connections[0].status, "error", "a real sync still records it");
});

// H230: the cron ordered by last_synced_at, set only on success. A user whose run was killed by
// the wall clock kept the oldest time and went first every run, so a user who always overran
// starved everyone after them. Each try is now stamped first, and the order follows the stamp.
Deno.test("cron: the user tried longest ago goes first, and each try is stamped before it starts", async () => {
  const s = setup({
    connections: [
      { ...conn({ user_id: "killed", last_synced_at: "2026-11-01T00:00:00Z" }), last_attempt_at: "2026-11-17T06:00:00Z" } as Connection,
      { ...conn({ user_id: "waiting", last_synced_at: "2026-11-10T00:00:00Z" }), last_attempt_at: "2026-11-10T00:00:00Z" } as Connection,
    ],
  });
  const order: string[] = [];
  const stampedBefore: unknown[] = [];
  const rpc = s.deps.rpc;
  s.deps.rpc = (fn, args) => {
    if (fn === "splitwise_read_key") {
      order.push(args.p_user as string);
      stampedBefore.push(s.db.tables.splitwise_connections.find((c) => c.user_id === args.p_user)?.last_attempt_at);
    }
    return rpc(fn, args);
  };
  await runAllUsers(s.deps, () => true);
  assertEquals(order, ["waiting", "killed"]);
  assertEquals(stampedBefore, [new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
});

// H232: the full check pages by offset, so a row the list shifted past was "missing" and deleted,
// releasing its bank-payment link. Up to 10 missing ids are now read one by one first.
Deno.test("a full check reads up to 10 missing ids again and removes only what Splitwise really lost", async () => {
  const s = setup({
    expenses: [expense(1)],
    reread: {
      7: expense(7, { updated_at: "2026-11-17T11:00:00Z" }), // skipped by the paging: still there
      8: expense(8, { deleted_at: "2026-11-16T00:00:00Z" }), // deleted
      10: new SplitwiseApiError("Splitwise answered HTTP 403", 403), // can't tell: kept
    },
    tables: {
      splitwise_expenses: [1, 7, 8, 9, 10].map((id) => ({ user_id: "u1", splitwise_id: id })),
      splitwise_review: [],
    },
  });
  const counts = await syncUser(s.deps, conn({ last_full_check_at: null }), { preview: false });
  assertEquals(s.reread.sort((a, b) => a - b), [7, 8, 9, 10]);
  const [args] = s.applies();
  assertEquals((args.p_deleted as number[]).sort(), [8, 9]);
  assertEquals((args.p_shares as Array<{ splitwise_id: number }>).map((r) => r.splitwise_id).sort((a, b) => a - b), [1, 7]);
  assertEquals(args.p_cursor, "2026-11-16T08:00:00.000Z", "the cursor is the full read's, not the re-read's");
  assertEquals(counts.deleted, 2);
});

Deno.test("a refused key or a rate limit during the re-read stops the sync and removes nothing", async () => {
  const s = setup({
    expenses: [expense(1)],
    reread: { 7: new SplitwiseRateLimitError("slow", 429) },
    tables: { splitwise_expenses: [1, 7].map((id) => ({ user_id: "u1", splitwise_id: id })), splitwise_review: [] },
  });
  let err: unknown = null;
  await syncUser(s.deps, conn({ last_full_check_at: null }), { preview: false }).catch((e) => (err = e));
  assertEquals(err instanceof SplitwiseRateLimitError, true);
  assertEquals(s.applies().length, 0);
});

// H230 (review): sync-splitwise deployed before its migration (20270121000000) ordered by a
// column that isn't there yet, so every cron run failed between the two deploy steps. It now
// falls back to the old order and stamps nothing until the column exists.
Deno.test("cron: without the last_attempt_at column, users still sync in the old order and nothing is stamped", async () => {
  const s = setup({ connections: [conn({ user_id: "late", last_synced_at: "2026-11-10T00:00:00Z" }), conn({ user_id: "early", last_synced_at: "2026-11-01T00:00:00Z" })] });
  const from = s.db.from.bind(s.db);
  const updates: unknown[] = [];
  const db = {
    ...s.db,
    from: (t: string) => {
      // deno-lint-ignore no-explicit-any
      const q: any = from(t);
      const order = q.order;
      q.order = (c: string, o?: { ascending?: boolean }) =>
        c === "last_attempt_at" ? { order: () => ({ limit: () => Promise.resolve({ data: null, error: { code: "42703" } }) }) } : order(c, o);
      const update = q.update;
      q.update = (v: Record<string, unknown>) => ("last_attempt_at" in v && updates.push(v), update(v));
      return q;
    },
  };
  const order: string[] = [];
  const rpc = s.deps.rpc;
  const error = console.error;
  console.error = () => {};
  try {
    const result = await runAllUsers({ ...s.deps, db, rpc: (fn, args) => (fn === "splitwise_read_key" && order.push(args.p_user as string), rpc(fn, args)) }, () => true);
    assertEquals([result.users, result.failed, order, updates.length], [2, 0, ["early", "late"], 0]);
  } finally {
    console.error = error;
  }
});
