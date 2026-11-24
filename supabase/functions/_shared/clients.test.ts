import { assertEquals } from "jsr:@std/assert@1.0.19";

// clients.ts reads the env at import: set it first, then import.
Deno.env.set("SUPABASE_URL", "http://db.test");
Deno.env.set("SUPABASE_ANON_KEY", "anon");
Deno.env.set("SUPABASE_SECRET_KEYS", JSON.stringify({ other: "sb_secret_b", default: "sb_secret_a" }));
const { SECRET_KEY, serviceClient, asUser, userCaller } = await import("./clients.ts");

function stubFetch(answer: (url: string, n: number) => Response) {
  const seen: { url: string; apikey: string | null; auth: string | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, apikey: req.headers.get("apikey"), auth: req.headers.get("Authorization") });
    return Promise.resolve(answer(req.url, seen.length));
  };
  return { seen, restore: () => (globalThis.fetch = real) };
}

Deno.test("the default secret key comes first", () => {
  assertEquals(SECRET_KEY, "sb_secret_a");
});

Deno.test("service client: secret key, one retry when PostgREST refuses the minted token", async () => {
  const f = stubFetch((_, n) =>
    n === 1 ? Response.json({ code: "PGRST303" }, { status: 401 }) : Response.json([{ id: 1 }])
  );
  try {
    const { data } = await serviceClient().from("t").select("id");
    assertEquals(data, [{ id: 1 }]);
    assertEquals(f.seen.map((s) => s.apikey), ["sb_secret_a", "sb_secret_a"]);
  } finally {
    f.restore();
  }
});

Deno.test("caller deps ask auth and mfa_satisfied with the caller's JWT", async () => {
  const f = stubFetch((url) =>
    url.includes("/auth/v1/user") ? Response.json({ id: "u1", aud: "authenticated" }) : Response.json(true)
  );
  try {
    assertEquals(await userCaller.userIdFor("Bearer jwt"), "u1");
    assertEquals(await userCaller.mfaRefusal("Bearer jwt"), null);
    assertEquals(f.seen.map((s) => [new URL(s.url).pathname, s.apikey, s.auth]), [
      ["/auth/v1/user", "anon", "Bearer jwt"],
      ["/rest/v1/rpc/mfa_satisfied", "anon", "Bearer jwt"],
    ]);
    // A bad token is no user, not an outage.
    const bad = stubFetch(() => Response.json({ msg: "bad jwt" }, { status: 401 }));
    try {
      assertEquals(await userCaller.userIdFor("Bearer bad"), null);
    } finally {
      bad.restore();
    }
  } finally {
    f.restore();
  }
});

Deno.test("asUser sends the caller's Authorization on table reads", async () => {
  const f = stubFetch(() => Response.json([]));
  try {
    await asUser("Bearer jwt").from("accounts").select("uid");
    assertEquals([f.seen[0].apikey, f.seen[0].auth], ["anon", "Bearer jwt"]);
  } finally {
    f.restore();
  }
});
