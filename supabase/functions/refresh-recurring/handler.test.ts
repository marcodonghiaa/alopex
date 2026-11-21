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

type Call = { p_user: string; p_rows: unknown[] };
const call = async (
  init: RequestInit & { headers?: Record<string, string> } = {},
  opts: { mfa?: { body: object; status: number } | null; rpcFails?: boolean; authDown?: boolean } = {},
) => {
  const calls: Call[] = [];
  const handler = refreshHandler({
    userIdFor: (a) => opts.authDown ? Promise.reject(new Error("down")) : Promise.resolve(a === "Bearer good" ? "u1" : null),
    mfaRefusal: () => Promise.resolve(opts.mfa ?? null),
    admin: () => seed(),
    rpc: (_fn, args) => {
      if (opts.rpcFails) return Promise.resolve({ data: null, error: { code: "XX000" } });
      calls.push(args as Call);
      return Promise.resolve({ data: 1, error: null });
    },
    today: () => "2026-10-20",
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
