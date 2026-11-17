import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  centsToDecimal,
  splitwiseClient,
  SplitwiseApiError,
  SplitwiseAuthError,
  SplitwiseRateLimitError,
  toCents,
} from "./splitwise-api.ts";

type Call = { url: URL; auth: string | null };
// A fake fetch: answers each call with the next reply, and records what was asked.
function fakeFetch(replies: Array<{ status?: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), auth: new Headers(init?.headers).get("Authorization") });
    const next = replies.shift();
    if (!next) throw new Error("no more replies");
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(
      new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {}), {
        status: next.status ?? 200,
        headers: next.headers,
      }),
    );
  };
  return { fn: fn as typeof fetch, calls };
}

Deno.test("toCents parses decimal strings exactly, no float drift", () => {
  assertEquals(toCents("25.0"), 2500);
  assertEquals(toCents("4.49"), 449);
  assertEquals(toCents("0.1"), 10);
  assertEquals(toCents("0.29"), 29); // 0.29 * 100 = 28.999999999999996 in floats
  assertEquals(toCents("1234567.89"), 123456789);
  assertEquals(toCents("-4.49"), -449);
  assertEquals(toCents("7"), 700);
  assertEquals(toCents(" 3.50 "), 350);
  assertEquals(toCents("0.00"), 0);
  assertEquals(toCents("-0.00"), 0);
  assertEquals(toCents(12.5), 1250);
});

Deno.test("toCents rounds a third decimal half away from zero", () => {
  assertEquals(toCents("3.335"), 334);
  assertEquals(toCents("3.334"), 333);
  assertEquals(toCents("-3.335"), -334);
  assertEquals(toCents("1.999"), 200);
});

Deno.test("toCents refuses anything that isn't an amount", () => {
  for (const bad of ["", "abc", "1,50", "1.2.3", "1e5", null, undefined, NaN, Infinity]) {
    assertThrows(() => toCents(bad as string), SplitwiseApiError);
  }
});

Deno.test("centsToDecimal writes exact two-decimal strings", () => {
  assertEquals(centsToDecimal(1234), "12.34");
  assertEquals(centsToDecimal(5), "0.05");
  assertEquals(centsToDecimal(-449), "-4.49");
  assertEquals(centsToDecimal(0), "0.00");
  assertEquals(centsToDecimal(100000000), "1000000.00");
});

Deno.test("currentUser sends the key as a Bearer token and returns the user", async () => {
  const f = fakeFetch([{ body: { user: { id: 7, first_name: "Ann", last_name: null } } }]);
  const user = await splitwiseClient("k3y", f.fn).currentUser();
  assertEquals(user, { id: 7, first_name: "Ann", last_name: null });
  assertEquals(f.calls[0].url.href, "https://secure.splitwise.com/api/v3.0/get_current_user");
  assertEquals(f.calls[0].auth, "Bearer k3y");
});

Deno.test("expenses pages with limit and offset until an empty page, with updated_after", async () => {
  const page = (from: number, n: number) => ({ body: { expenses: Array.from({ length: n }, (_, i) => ({ id: from + i })) } });
  const f = fakeFetch([page(0, 3), page(3, 3), page(6, 1), page(7, 0)]);
  const rows = await splitwiseClient("k", f.fn, { pageSize: 3 }).expenses({ updatedAfter: "2026-11-01T00:00:00.000Z" });
  assertEquals(rows.map((r) => r.id), [0, 1, 2, 3, 4, 5, 6]);
  assertEquals(f.calls.map((c) => c.url.searchParams.get("offset")), ["0", "3", "6", "7"]);
  assertEquals(f.calls.map((c) => c.url.searchParams.get("limit")), ["3", "3", "3", "3"]);
  assertEquals(f.calls[0].url.searchParams.get("updated_after"), "2026-11-01T00:00:00.000Z");
  // Deleted expenses must come back (they carry deleted_at): never filter them out.
  assertEquals(f.calls[0].url.searchParams.has("visible"), false);
});

// polish-1 #5: Splitwise documents no maximum limit; a server that caps pages below ours must not
// end the read early (the weekly full check would then delete every expense after page 1).
Deno.test("expenses keeps reading after a page shorter than asked, from where it left off", async () => {
  const page = (from: number, n: number) => ({ body: { expenses: Array.from({ length: n }, (_, i) => ({ id: from + i })) } });
  const f = fakeFetch([page(0, 2), page(2, 2), page(4, 1), page(5, 0)]);
  const rows = await splitwiseClient("k", f.fn, { pageSize: 3 }).expenses();
  assertEquals(rows.map((r) => r.id), [0, 1, 2, 3, 4]);
  assertEquals(f.calls.map((c) => c.url.searchParams.get("offset")), ["0", "2", "4", "5"]);
});

Deno.test("expenses without updated_after reads everything; an empty first page ends it", async () => {
  const f = fakeFetch([{ body: { expenses: [] } }]);
  assertEquals(await splitwiseClient("k", f.fn).expenses(), []);
  assertEquals(f.calls[0].url.searchParams.has("updated_after"), false);
  assertEquals(f.calls[0].url.searchParams.get("limit"), "200");
});

Deno.test("expenses stops at the page cap instead of looping forever", async () => {
  const full = { body: { expenses: [{ id: 1 }, { id: 2 }] } };
  const f = fakeFetch([full, full, full]);
  await assertRejects(() => splitwiseClient("k", f.fn, { pageSize: 2, maxPages: 2 }).expenses(), SplitwiseApiError, "too many");
  assertEquals(f.calls.length, 2);
});

Deno.test("groups and friends", async () => {
  const f = fakeFetch([{ body: { groups: [{ id: 0, name: "Non-group expenses", members: [] }] } }, { body: { friends: [{ id: 9 }] } }]);
  const api = splitwiseClient("k", f.fn);
  assertEquals((await api.groups())[0].id, 0);
  assertEquals((await api.friends())[0].id, 9);
  assertEquals(f.calls.map((c) => c.url.pathname), ["/api/v3.0/get_groups", "/api/v3.0/get_friends"]);
});

Deno.test("401 is an auth error, without the key in the message", async () => {
  const f = fakeFetch([{ status: 401, body: { error: "Invalid API request: you are not logged in" } }]);
  const err = await assertRejects(() => splitwiseClient("secret-key", f.fn).currentUser(), SplitwiseAuthError);
  assertEquals(err.message.includes("secret-key"), false);
  assertEquals(err.status, 401);
});

Deno.test("429 is a rate-limit error, with Retry-After when sent", async () => {
  const f = fakeFetch([{ status: 429, headers: { "Retry-After": "30" } }, { status: 429 }]);
  const api = splitwiseClient("k", f.fn);
  assertEquals((await assertRejects(() => api.groups(), SplitwiseRateLimitError)).retryAfterSeconds, 30);
  assertEquals((await assertRejects(() => api.groups(), SplitwiseRateLimitError)).retryAfterSeconds, null);
});

Deno.test("other HTTP errors, success:false, errors and junk bodies are API errors with a safe message", async () => {
  const f = fakeFetch([
    { status: 500, body: "<html>oops k</html>" },
    { status: 403, body: { errors: { base: ["Invalid API request: you do not have permission"] } } },
    { body: { success: false, errors: { base: ["nope"] } } },
    { body: { errors: { base: ["bad thing"] } } },
    { body: "not json" },
    { body: { user: null } },
    { body: { expenses: "x" } },
  ]);
  const api = splitwiseClient("k", f.fn);
  const e500 = await assertRejects(() => api.currentUser(), SplitwiseApiError);
  assertEquals([e500.status, e500.message], [500, "Splitwise answered HTTP 500"]);
  assertEquals((await assertRejects(() => api.currentUser(), SplitwiseApiError)).status, 403);
  assertEquals((await assertRejects(() => api.currentUser(), SplitwiseApiError)).message, "Splitwise refused the request");
  assertEquals((await assertRejects(() => api.currentUser(), SplitwiseApiError)).message, "Splitwise refused the request");
  assertEquals((await assertRejects(() => api.currentUser(), SplitwiseApiError)).message, "Splitwise sent an unreadable answer");
  assertEquals((await assertRejects(() => api.currentUser(), SplitwiseApiError)).message, "Splitwise sent an unreadable answer");
  assertEquals((await assertRejects(() => api.expenses(), SplitwiseApiError)).message, "Splitwise sent an unreadable answer");
});

Deno.test("a network failure is passed on as it is", async () => {
  const f = fakeFetch([new TypeError("network down")]);
  await assertRejects(() => splitwiseClient("k", f.fn).groups(), TypeError);
});

// polish-1 #6: one hanging request must not hold the cron run until the platform kills it.
Deno.test("a call Splitwise doesn't answer in time is an API error with a safe message", async () => {
  let signal: AbortSignal | undefined;
  const hang = ((_input: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  }) as typeof fetch;
  const err = await assertRejects(() => splitwiseClient("k", hang, { timeoutMs: 20 }).expenses(), SplitwiseApiError);
  assertEquals([err.message, err.status], ["Splitwise did not answer in time", null]);
  assertEquals(signal?.aborted, true);
});
