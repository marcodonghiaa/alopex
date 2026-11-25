// Server-to-server auth with the project's secret API keys (sb_secret_...). They are not JWTs:
// the gateway's verify_jwt only understands the legacy keys, so functions called this way set
// verify_jwt = false and check the apikey header here. Kept free of Deno.env for the tests.
import { timingSafeEqual } from "jsr:@std/crypto@1.1.0/timing-safe-equal";

/** SUPABASE_SECRET_KEYS is a JSON object of named keys ({"default": "sb_secret_..."}). */
export function parseSecretKeys(json: string | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(json ?? "{}");
    // Only an object of named keys: a bare JSON string would split into one-letter "keys".
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === "string" && v.length > 0),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

/** True when the apikey header is one of the keys. No keys configured: always false. */
export function hasSecretKey(req: Request, keys: Record<string, string>): boolean {
  const enc = new TextEncoder();
  const given = enc.encode(req.headers.get("apikey") ?? "");
  return Object.values(keys).some((key) => {
    const expected = enc.encode(key);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

type Env = (name: string) => string | undefined;

// SUPABASE_SECRET_KEYS / SUPABASE_PUBLISHABLE_KEYS: the "default" key, else the first one.
const firstKey = (json: string | undefined): string | undefined => {
  const keys = parseSecretKeys(json);
  return keys.default ?? Object.values(keys)[0];
};

/** The server's key: a project secret key (sb_secret_...), else the legacy service_role key. */
export function serviceKey(env: Env): string {
  return firstKey(env("SUPABASE_SECRET_KEYS")) ?? env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

/** The key a caller's client sends: a publishable key (sb_publishable_...), else the legacy anon key. */
export function userKey(env: Env): string {
  return firstKey(env("SUPABASE_PUBLISHABLE_KEYS")) ?? env("SUPABASE_ANON_KEY") ?? "";
}
