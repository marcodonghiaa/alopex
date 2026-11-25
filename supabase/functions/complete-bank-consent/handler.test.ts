import { assertEquals } from "jsr:@std/assert@1.0.19";
import { completeHandler, type Deps } from "./handler.ts";
import { CLAIM_FAILED, EXPIRED_CONSENT, INVALID_CONSENT } from "../_shared/consent-claim.ts";

// H289: who gets linked, and when a refused code is closed at Enable Banking (H165: the caller's own
// expired link too, not only a state that belongs to someone else).
const STATE = "11111111-2222-4333-8444-555555555555";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Pending = { user_id: string; created_at: string } | null;
const setup = ({ mine = null as Pending, exists = false, claimError = null as unknown } = {}) => {
  const calls = { burned: [] as string[], linked: [] as string[][], synced: [] as string[][] };
  const chain = (result: unknown) => {
    const q = { delete: () => q, select: () => q, eq: () => q, maybeSingle: () => Promise.resolve(result) };
    return q;
  };
  const deps: Deps = {
    userIdFor: () => Promise.resolve("u1"),
    mfaRefusal: () => Promise.resolve(null),
    asUser: () => ({ from: () => chain({ data: mine, error: claimError }) }),
    service: { from: () => chain({ data: exists ? { id: STATE } : null, error: null }) },
    linkAccounts: (userId, code) => (calls.linked.push([userId, code]), Promise.resolve({ params: { linked: "1" }, syncUids: ["a1"] })),
    burnCode: (code) => (calls.burned.push(code), Promise.resolve()),
    afterLink: (uids) => void calls.synced.push(uids),
  };
  const call = async (body: unknown = { code: "c1", state: STATE }, method = "POST") => {
    const res = await completeHandler(deps)(
      new Request("http://x", { method, headers: { Authorization: "Bearer t" }, body: method === "POST" ? JSON.stringify(body) : undefined }),
      json,
    );
    return { status: res.status, body: await res.json() };
  };
  return { call, calls };
};
const now = () => new Date().toISOString();

Deno.test("complete-bank-consent: the caller's own fresh link is linked and its first sync started", async () => {
  const { call, calls } = setup({ mine: { user_id: "u1", created_at: now() } });
  assertEquals(await call(), { status: 200, body: { linked: "1" } });
  assertEquals([calls.linked, calls.synced, calls.burned], [[["u1", "c1"]], [["a1"]], []]);
});

Deno.test("complete-bank-consent: another user's state links nothing and closes the code", async () => {
  const { call, calls } = setup({ exists: true });
  assertEquals(await call(), { status: 403, body: { error: INVALID_CONSENT } });
  assertEquals([calls.linked, calls.burned], [[], ["c1"]]);
});

Deno.test("complete-bank-consent: an unknown state costs no bank call; an expired own link closes the code", async () => {
  const unknown = setup();
  assertEquals((await unknown.call()).status, 403);
  assertEquals(unknown.calls.burned, []);
  const expired = setup({ mine: { user_id: "u1", created_at: "2026-01-01T00:00:00Z" } });
  assertEquals(await expired.call(), { status: 403, body: { error: EXPIRED_CONSENT } });
  assertEquals([expired.calls.linked, expired.calls.burned], [[], ["c1"]]);
});

Deno.test("complete-bank-consent: a database error is a 503 and closes nothing; bad input is refused", async () => {
  const { call, calls } = setup({ claimError: { code: "XX000" } });
  assertEquals(await call(), { status: 503, body: { error: CLAIM_FAILED } });
  assertEquals((await call({ code: "c1", state: "not-a-uuid" })).status, 400);
  assertEquals((await call(undefined, "GET")).status, 405);
  assertEquals([calls.linked, calls.burned], [[], []]);
});
