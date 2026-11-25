import { assertEquals } from "jsr:@std/assert@1.0.19";
import { burnCode, closeReplaced, closeSessions, relinkPatch, replacedSessions } from "./eb-sessions.ts";

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

// accounts: rows the re-read sees right before closing; deleted: bank_sessions ids removed.
function fakeDb(accounts: Array<{ bank_session_id: string | null }>, failDelete = false, failRead = false) {
  const deleted: string[][] = [];
  const reads: string[][] = [];
  const deleteFilters: string[][] = [];
  const db = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          in: (_col: string, ids: string[]) => {
            reads.push(ids);
            if (failRead) return Promise.resolve({ data: null, error: { message: "read failed" } });
            return Promise.resolve({ data: accounts.filter((a) => ids.includes(a.bank_session_id ?? "")), error: null });
          },
        }),
      }),
      delete: () => {
        const q = {
          eq: (col: string, value: string) => {
            if (table === "bank_sessions") deleteFilters.push([col, value]);
            return q;
          },
          in: (_col: string, ids: string[]) => {
            if (table === "bank_sessions") deleted.push(ids);
            return Promise.resolve({ error: failDelete ? { message: "x" } : null });
          },
        };
        return q;
      },
    }),
  };
  return { db, deleted, reads, deleteFilters };
}
const okFetch = (calls: string[]) => ((url: string) => {
  calls.push(url);
  return Promise.resolve(new Response(null, { status: 204 }));
}) as unknown as typeof fetch;

Deno.test("closeReplaced: closes the replaced session and drops its row", async () => {
  const { db, deleted } = fakeDb([]);
  const calls: string[] = [];
  await closeReplaced(db, "u", [{ uid: "a", bank_session_id: "old" }], new Set(["a"]), "new", okFetch(calls), sign);
  assertEquals(calls, ["https://api.enablebanking.com/sessions/old"]);
  assertEquals(deleted, [["old"]]);
});
Deno.test("closeReplaced: a session another renewal started using meanwhile stays open", async () => {
  const { db, deleted, reads } = fakeDb([{ bank_session_id: "old" }]);
  const calls: string[] = [];
  await closeReplaced(db, "u", [{ uid: "a", bank_session_id: "old" }], new Set(["a"]), "new", okFetch(calls), sign);
  assertEquals(reads, [["old"]]);
  assertEquals(calls, []);
  assertEquals(deleted, []);
});
Deno.test("closeReplaced: nothing replaced, no read and no bank call", async () => {
  const { db, reads } = fakeDb([]);
  const calls: string[] = [];
  await closeReplaced(db, "u", [{ uid: "a", bank_session_id: "new" }], new Set(["a"]), "new", okFetch(calls), sign);
  assertEquals([reads, calls], [[], []]);
});
Deno.test("closeReplaced: a failed close keeps the row so account deletion can retry", async () => {
  const { db, deleted } = fakeDb([]);
  const fail = (() => Promise.resolve(new Response(null, { status: 500 }))) as unknown as typeof fetch;
  await quiet(() => closeReplaced(db, "u", [{ uid: "a", bank_session_id: "old" }], new Set(["a"]), "new", fail, sign));
  assertEquals(deleted, []);
});
Deno.test("closeReplaced: a database error never fails the link", async () => {
  const { db } = fakeDb([], true);
  await quiet(() => closeReplaced(db, "u", [{ uid: "a", bank_session_id: "old" }], new Set(["a"]), "new", okFetch([]), sign));
});
Deno.test("closeReplaced: drops only this user's bank_sessions rows", async () => {
  const { db, deleteFilters } = fakeDb([]);
  await closeReplaced(db, "u", [{ uid: "a", bank_session_id: "old" }], new Set(["a"]), "new", okFetch([]), sign);
  assertEquals(deleteFilters, [["user_id", "u"]]);
});
// Polish 5 F2: without the re-read, a session a second renewal just took could be closed.
Deno.test("closeReplaced: a failed re-read closes nothing and deletes nothing", async () => {
  const { db, deleted, reads } = fakeDb([], false, true);
  const calls: string[] = [];
  await quiet(() => closeReplaced(db, "u", [{ uid: "a", bank_session_id: "old" }], new Set(["a"]), "new", okFetch(calls), sign));
  assertEquals(reads, [["old"]]);
  assertEquals(calls, []);
  assertEquals(deleted, []);
});

// H245: burnCode's own POST and DELETE had no timeout (closeSessions' DELETE has one).
Deno.test("burnCode: both Enable Banking calls have a timeout", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const fn = ((_url: string, init: RequestInit = {}) => {
    signals.push(init.signal);
    return Promise.resolve(Response.json(signals.length === 1 ? { session_id: "s1" } : {}));
  }) as unknown as typeof fetch;
  await burnCode("code", fn, sign);
  assertEquals(signals.length, 2);
  assertEquals(signals.every((s) => s instanceof AbortSignal), true);
});
