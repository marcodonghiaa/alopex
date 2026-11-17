import { assertEquals } from "jsr:@std/assert@1.0.19";
import { burnCode, closeSessions, relinkPatch, replacedSessions } from "./eb-sessions.ts";

const sign = () => Promise.resolve("jwt");
const quiet = async (fn: () => Promise<void>) => {
  const original = console.error;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = original;
  }
};
const replies = (...results: Array<number | Error | [number, unknown]>) => {
  const calls: Array<{ url: string; method?: string }> = [];
  const fn = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method });
    const r = results[calls.length - 1];
    if (r instanceof Error) return Promise.reject(r);
    const [status, body] = Array.isArray(r) ? r : [r, {}];
    return Promise.resolve(Response.json(body, { status }));
  }) as unknown as typeof fetch;
  return { calls, fn };
};

Deno.test("closeSessions: closed and already-gone (404) count, failures don't stop the rest", async () => {
  const { calls, fn } = replies(200, 404, 500, new TypeError("net"));
  await quiet(async () => {
    assertEquals(await closeSessions(["a", "b", "c", "d/e"], fn, sign), 2);
  });
  assertEquals(calls.map((c) => c.method), ["DELETE", "DELETE", "DELETE", "DELETE"]);
  assertEquals(calls[3].url, "https://api.enablebanking.com/sessions/d%2Fe");
});

Deno.test("closeSessions: nothing to close, no bank call", async () => {
  const { calls, fn } = replies();
  assertEquals(await closeSessions([], fn, sign), 0);
  assertEquals(calls.length, 0);
});

Deno.test("burnCode: exchanges the code, then closes the session it opened", async () => {
  const { calls, fn } = replies([200, { session_id: "s1" }], 200);
  await burnCode("code", fn, sign);
  assertEquals(calls, [
    { url: "https://api.enablebanking.com/sessions", method: "POST" },
    { url: "https://api.enablebanking.com/sessions/s1", method: "DELETE" },
  ]);
});

Deno.test("burnCode: a refused code opens nothing to close, and errors are swallowed", async () => {
  const refused = replies([400, { error: "bad" }]);
  await burnCode("code", refused.fn, sign);
  assertEquals(refused.calls.length, 1);
  await quiet(() => burnCode("code", replies(new TypeError("net")).fn, sign));
});

Deno.test("replacedSessions: a renewal frees the old session only when no account still uses it", () => {
  const before = [
    { uid: "a", bank_session_id: "old" },
    { uid: "b", bank_session_id: "old" },
    { uid: "c", bank_session_id: "other" },
    { uid: "d", bank_session_id: "solo" },
  ];
  // a and d renewed on "new"; b (not shared again) still reads "old"; c is another bank.
  assertEquals(replacedSessions(before, new Set(["a", "d"]), "new"), ["solo"]);
  // b renewed too: "old" is now unused.
  assertEquals(replacedSessions(before, new Set(["a", "b", "d"]), "new").sort(), ["old", "solo"]);
});

Deno.test("replacedSessions: unknown or unchanged sessions are never closed", () => {
  const before = [{ uid: "a", bank_session_id: null }, { uid: "b", bank_session_id: "same" }];
  assertEquals(replacedSessions(before, new Set(["a", "b"]), "same"), []);
});

// Polish 1 #3: a renewal must clear the last sync error, or "Connect again" stays on the Accounts
// page for up to 6 hours after the user just did it.
Deno.test("relinkPatch: a renewal records its session and clears the last sync error", () => {
  assertEquals(relinkPatch("new"), { bank_session_id: "new", sync_error: null, sync_error_at: null });
});

Deno.test("relinkPatch: no session id from Enable Banking changes nothing", () => {
  assertEquals(relinkPatch(null), {});
});
