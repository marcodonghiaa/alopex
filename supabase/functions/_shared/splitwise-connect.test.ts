import { assertEquals } from "jsr:@std/assert@1.0.19";
import { SplitwiseApiError, SplitwiseAuthError, SplitwiseProRequiredError, SplitwiseRateLimitError, type SwUser } from "./splitwise-api.ts";
import { connectHandler, type ConnectDeps } from "./splitwise-connect.ts";

const KEY = "AbCdEf0123456789xyz";
type RpcCall = { fn: string; args: Record<string, unknown> };
function setup(over: Partial<ConnectDeps> & { me?: SwUser | Error; rpcError?: unknown; attemptError?: unknown } = {}) {
  const calls: RpcCall[] = [];
  const keys: string[] = [];
  const attempts: Record<string, unknown>[] = []; // splitwise_attempt calls, kept apart from calls
  const deps: ConnectDeps = {
    userIdFor: (a) => Promise.resolve(a === "Bearer good" ? "u1" : null),
    mfaRefusal: () => Promise.resolve(null),
    rpc: (fn, args) => {
      if (fn === "splitwise_attempt") { // as the SQL: at most p_max per user and kind (here, ever)
        attempts.push(args);
        if (over.attemptError) return Promise.resolve({ data: null, error: over.attemptError });
        return Promise.resolve({ data: attempts.filter((a) => a.p_user === args.p_user && a.p_kind === args.p_kind).length <= (args.p_max as number), error: null });
      }
      calls.push({ fn, args });
      if (over.rpcError) return Promise.resolve({ data: null, error: over.rpcError });
      return Promise.resolve({ data: fn === "splitwise_disconnect" ? { deleted: 3 } : null, error: null });
    },
    client: (key) => ({
      currentUser: () => {
        keys.push(key);
        const me = over.me ?? { id: 42, first_name: "Ann", last_name: "Lee" };
        return me instanceof Error ? Promise.reject(me) : Promise.resolve(me);
      },
    }),
    ...over,
  };
  const h = connectHandler(deps);
  const call = async (body: unknown, init: RequestInit = {}) => {
    const res = await h(
      new Request("http://x/splitwise-connect", {
        method: "POST",
        headers: { Authorization: "Bearer good" },
        body: typeof body === "string" ? body : JSON.stringify(body),
        ...init,
      }),
      (b, status = 200) => new Response(JSON.stringify(b), { status }),
    );
    return { status: res.status, body: await res.json() };
  };
  return { call, calls, keys, attempts };
}

Deno.test("only POST, signed in, past two-step sign-in", async () => {
  assertEquals((await setup().call(null, { method: "GET", body: undefined })).status, 405);
  assertEquals((await setup().call({}, { headers: {} })).status, 401);
  assertEquals((await setup().call({}, { headers: { Authorization: "Bearer bad" } })).status, 401);
  assertEquals((await setup({ userIdFor: () => Promise.reject(new Error("down")) }).call({})).status, 503);
  const mfa = setup({ mfaRefusal: () => Promise.resolve({ body: { code: "mfa_required" }, status: 403 }) });
  assertEquals(await mfa.call({ apiKey: KEY, consent: true }), { status: 403, body: { code: "mfa_required" } });
  assertEquals(mfa.calls, []);
  const mfaDown = setup({ mfaRefusal: () => Promise.reject(new Error("x")) });
  assertEquals(await mfaDown.call({}), { status: 503, body: { error: "Sign-in check is unavailable, please try again" } });
});

Deno.test("connect: checks the key with Splitwise, then stores it with the consent", async () => {
  const s = setup();
  assertEquals(await s.call({ apiKey: ` ${KEY} `, consent: true }), { status: 200, body: { displayName: "Ann Lee" } });
  assertEquals(s.keys, [KEY]);
  assertEquals(s.calls, [{
    fn: "splitwise_save_connection",
    args: { p_user: "u1", p_key: KEY, p_splitwise_user_id: 42, p_display_name: "Ann Lee" },
  }]);
});

Deno.test("connect: no consent, or no usable key, is refused before Splitwise is asked", async () => {
  for (const body of [{ apiKey: KEY }, { apiKey: KEY, consent: "yes" }, { apiKey: "", consent: true }, { apiKey: "short", consent: true },
    { apiKey: "has spaces in it ok", consent: true }, { apiKey: "x".repeat(201), consent: true }, { consent: true }, "not json", null]) {
    const s = setup();
    assertEquals((await s.call(body)).status, 400, JSON.stringify(body));
    assertEquals([s.keys, s.calls], [[], []]);
  }
});

Deno.test("connect: a body too large is refused", async () => {
  assertEquals((await setup().call({ apiKey: KEY, consent: true, pad: "x".repeat(20000) })).status, 413);
});

Deno.test("connect: what Splitwise answers decides the reply; nothing is stored on failure", async () => {
  const bad = setup({ me: new SplitwiseAuthError("x", 401) });
  assertEquals((await bad.call({ apiKey: KEY, consent: true })), { status: 400, body: { error: "Splitwise did not accept this API key." } });
  assertEquals(bad.calls, []);
  assertEquals((await setup({ me: new SplitwiseRateLimitError("x", 429) }).call({ apiKey: KEY, consent: true })).status, 429);
  assertEquals((await setup({ me: new SplitwiseApiError("x", 500) }).call({ apiKey: KEY, consent: true })).status, 502);
  assertEquals((await setup({ me: new TypeError("net") }).call({ apiKey: KEY, consent: true })).status, 502);
});

// Splitwise serves API keys only to accounts with Splitwise Pro; the file import works without.
Deno.test("connect: a key whose account has no Splitwise Pro is refused with code pro_required; nothing stored", async () => {
  const s = setup({ me: new SplitwiseProRequiredError("x", 403) });
  assertEquals(await s.call({ apiKey: KEY, consent: true }), {
    status: 400,
    body: {
      error: "This key's Splitwise account has no active Splitwise Pro subscription, which Splitwise requires for API keys. Import a Splitwise file instead.",
      code: "pro_required",
    },
  });
  assertEquals(s.calls.filter((c) => c.fn === "splitwise_save_connection"), []);
});

Deno.test("connect: a nameless Splitwise user gets a generic name; a database failure is a 500", async () => {
  assertEquals((await setup({ me: { id: 7, first_name: null } }).call({ apiKey: KEY, consent: true })).body, { displayName: "Splitwise user 7" });
  assertEquals((await setup({ rpcError: { code: "XX000" } }).call({ apiKey: KEY, consent: true })).status, 500);
});

Deno.test("disconnect: removes the key; deleteData only when exactly true", async () => {
  const s = setup();
  assertEquals(await s.call({ disconnect: true, deleteData: true }), { status: 200, body: { disconnected: true, deleted: 3 } });
  await s.call({ disconnect: true, deleteData: "yes" });
  await s.call({ disconnect: true });
  assertEquals(s.calls.map((c) => c.args), [
    { p_user: "u1", p_delete_data: true },
    { p_user: "u1", p_delete_data: false },
    { p_user: "u1", p_delete_data: false },
  ]);
  assertEquals(s.keys, []);
  assertEquals((await setup({ rpcError: { code: "XX000" } }).call({ disconnect: true })).status, 500);
});

// polish-2 #2: a signed-in user cannot test keys against Splitwise through us without limit.
Deno.test("connect: 5 key checks per 10 minutes per user, counted before Splitwise is asked", async () => {
  const s = setup();
  for (let i = 0; i < 5; i++) assertEquals((await s.call({ apiKey: KEY, consent: true })).status, 200);
  assertEquals(await s.call({ apiKey: KEY, consent: true }), {
    status: 429,
    body: { error: "Too many tries. Wait 10 minutes and try again." },
  });
  assertEquals(s.keys.length, 5);
  assertEquals(s.attempts.length, 6);
  assertEquals(s.attempts[0], { p_user: "u1", p_kind: "connect", p_max: 5, p_window: "10 minutes" });
  // A key that cannot be one never reaches the check; disconnect is not limited.
  assertEquals((await s.call({ apiKey: "short", consent: true })).status, 400);
  assertEquals((await s.call({ disconnect: true })).status, 200);
  assertEquals(s.attempts.length, 6);
  // The check failing stops the connect too.
  const down = setup({ attemptError: { code: "57014" } });
  assertEquals((await down.call({ apiKey: KEY, consent: true })).status, 503);
  assertEquals(down.keys, []);
});

// polish-3 #10: the dashboard shows these as they are, in its own "Couldn't …. Try again later." style.
Deno.test("database failures say what failed in the dashboard's copy style", async () => {
  const save = await setup({ rpcError: { code: "XX000" } }).call({ apiKey: KEY, consent: true });
  assertEquals(save.body, { error: "Couldn't save the connection. Try again later." });
  const off = await setup({ rpcError: { code: "XX000" } }).call({ disconnect: true });
  assertEquals(off.body, { error: "Couldn't disconnect Splitwise. Try again later." });
});
