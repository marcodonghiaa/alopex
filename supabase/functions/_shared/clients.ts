// The Supabase clients the Edge Functions build at startup, written once: the service client
// (project secret key, retried when PostgREST refuses a fresh token) and the caller's own client.
import { createClient } from "jsr:@supabase/supabase-js@2.119.0";
import { parseSecretKeys } from "./secret-key.ts";
import { retryRejectedToken } from "./postgrest-retry.ts";
import { type CallerDeps, userIdFrom } from "./caller.ts";
import { mfaRefusal } from "./mfa.ts";

const url = Deno.env.get("SUPABASE_URL")!;
export const SECRET_KEYS = parseSecretKeys(Deno.env.get("SUPABASE_SECRET_KEYS"));
export const SECRET_KEY: string | undefined = SECRET_KEYS.default ?? Object.values(SECRET_KEYS)[0];

// Without secret keys, server calls are refused (hasSecretKey); a signed-in caller's request
// still works with the legacy service-role key.
export const serviceClient = () =>
  createClient(url, SECRET_KEY ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    global: { fetch: retryRejectedToken(fetch) },
  });

/** A client that acts as the caller: their JWT, so RLS applies. */
export const asUser = (authorization: string) =>
  createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authorization } } });

/** callerOrReply's deps for a real request: auth.getUser and mfa_satisfied with the caller's JWT. */
export const userCaller: CallerDeps = {
  async userIdFor(authorization) {
    return userIdFrom(await asUser(authorization).auth.getUser());
  },
  async mfaRefusal(authorization) {
    return await mfaRefusal(asUser(authorization));
  },
};
