import { assertEquals } from "jsr:@std/assert@1.0.19";
import { type DeleteAccountDeps, deleteAccountHandler } from "./handler.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const BODY = { confirm: "DELETE", password: "pw" };

type Over = {
  user?: { id: string; email?: string } | null;
  userError?: unknown;
  mfa?: { data: unknown; error: unknown };
  signedInAs?: string | null;
  passwordError?: unknown;
  allowed?: { data: unknown; error: unknown };
  sessions?: { data: { session_id: string }[] | null; error: unknown };
  deleteError?: unknown;
  closeFails?: boolean;
};

function setup(o: Over = {}) {
  const steps: string[] = [];
  const deps: DeleteAccountDeps = {
    asUser: (authorization) => ({
      auth: {
        getUser: () => {
          steps.push(`getUser ${authorization}`);
          const user = "user" in o ? o.user! : { id: "u1", email: "a@b.c" };
          return Promise.resolve({ data: { user }, error: o.userError ?? null });
        },
      },
      rpc: (fn: string) => (steps.push(fn), Promise.resolve(o.mfa ?? { data: true, error: null })),
    }) as ReturnType<DeleteAccountDeps["asUser"]>,
    signIn: (email, password) => {
      steps.push(`signIn ${email} ${password}`);
      const id = "signedInAs" in o ? o.signedInAs : "u1";
      return Promise.resolve({ data: { user: id ? { id } : null }, error: o.passwordError ?? null });
    },
    rpc: (fn, args) => (steps.push(`${fn} ${args.p_user}`), Promise.resolve(o.allowed ?? { data: true, error: null })),
    sessionIds: (userId) => (steps.push(`sessions ${userId}`), Promise.resolve(o.sessions ?? { data: [{ session_id: "s1" }], error: null })),
    deleteUser: (userId) => (steps.push(`deleteUser ${userId}`), Promise.resolve({ error: o.deleteError ?? null })),
    closeSessions: (ids) => {
      steps.push(`close ${ids.join(",")}`);
      return o.closeFails ? Promise.reject(new Error("eb down")) : Promise.resolve(ids.length);
    },
  };
  const call = async (body: unknown = BODY, method = "POST") => {
    const res = await deleteAccountHandler(deps)(
      new Request("http://x/delete-account", {
        method,
        headers: { Authorization: "Bearer jwt" },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      }),
      json,
    );
    return { status: res.status, body: await res.json() };
  };
  return { call, steps };
}

const SORRY = { error: "Couldn't delete the account, please try again" };

Deno.test("password checked, then owner guard, then delete, then bank sessions closed", async () => {
  const s = setup();
  assertEquals(await s.call(), { status: 200, body: { ok: true } });
  assertEquals(s.steps, [
    "getUser Bearer jwt",
    "mfa_satisfied",
    "signIn a@b.c pw",
    "can_delete_user u1",
    "sessions u1",
    "deleteUser u1",
    "close s1",
  ]);
});

Deno.test("only POST, signed in, past two-step sign-in", async () => {
  assertEquals((await setup().call(null, "GET")).status, 405);
  assertEquals(await setup({ user: null }).call(), { status: 401, body: { error: "Not signed in" } });
  // Any getUser error is "not signed in", an auth outage included.
  assertEquals((await setup({ userError: { status: 500 } }).call()).status, 401);
  const mfa = setup({ mfa: { data: false, error: null } });
  assertEquals((await mfa.call()).status, 403);
  assertEquals(mfa.steps.some((x) => x.startsWith("signIn")), false);
});

Deno.test("the body must confirm with DELETE and a password", async () => {
  assertEquals(await setup().call({ password: "pw" }), { status: 400, body: { error: "Type DELETE to confirm" } });
  for (const password of [undefined, "", 7, "x".repeat(1025)]) {
    assertEquals((await setup().call({ confirm: "DELETE", password })).body, { error: "Enter your password to confirm" });
  }
  assertEquals((await setup().call("not json")).status, 400);
  assertEquals(await setup({ user: { id: "u1" } }).call(), { status: 400, body: { error: "This account has no password to confirm with" } });
});

Deno.test("a wrong password or another user is refused, nothing deleted", async () => {
  for (const o of [{ passwordError: { status: 400 } }, { signedInAs: "u9" }, { signedInAs: null }]) {
    const s = setup(o);
    assertEquals(await s.call(), { status: 403, body: { error: "Wrong password" } });
    assertEquals(s.steps.some((x) => x.startsWith("can_delete_user")), false);
  }
});

Deno.test("the instance owner with other users can't delete; failures stop before the delete", async () => {
  const owner = setup({ allowed: { data: false, error: null } });
  assertEquals(await owner.call(), { status: 409, body: { error: "You set up this instance: remove the other users first" } });
  assertEquals(owner.steps.includes("deleteUser u1"), false);
  assertEquals(await setup({ allowed: { data: null, error: { code: "XX000" } } }).call(), { status: 500, body: SORRY });
  const noSessions = setup({ sessions: { data: null, error: { code: "XX000" } } });
  assertEquals(await noSessions.call(), { status: 500, body: SORRY });
  assertEquals(noSessions.steps.includes("deleteUser u1"), false);
});

Deno.test("a failed delete closes no bank session; a failed close still answers ok", async () => {
  const failed = setup({ deleteError: { status: 500 } });
  assertEquals(await failed.call(), { status: 500, body: SORRY });
  assertEquals(failed.steps.some((x) => x.startsWith("close")), false);
  assertEquals(await setup({ closeFails: true }).call(), { status: 200, body: { ok: true } });
  assertEquals((await setup({ sessions: { data: null, error: null } }).call()).status, 200);
});
