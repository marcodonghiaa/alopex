// Who is calling a user-facing Edge Function, and whether they may: the sign-in check and the
// database's two-step check, shared so a fix to one applies to every function that uses them.
import type { Reply } from "./origins.ts";
import { errorTag } from "./log-safe.ts";

export interface CallerDeps {
  // Who signed this request; null for a bad or expired token, throws if auth can't be reached.
  userIdFor(authorization: string): Promise<string | null>;
  // The database's two-step sign-in check, asked with the caller's JWT: the service key skips
  // it. null when satisfied, else the reply to send (see mfa.ts).
  mfaRefusal(authorization: string): Promise<{ body: object; status: number } | null>;
}

/** The caller's user id, or the reply to send instead (401, 503, or the two-step refusal). */
export async function callerOrReply(req: Request, deps: CallerDeps, json: Reply, fn: string): Promise<string | Response> {
  const authorization = req.headers.get("Authorization");
  let userId: string | null = null;
  try {
    userId = authorization ? await deps.userIdFor(authorization) : null;
  } catch (err) {
    console.error(`${fn} auth check failed: ${errorTag(err)}`);
    return json({ error: "Sign-in check is unavailable, please try again" }, 503);
  }
  if (!userId) return json({ error: "Not signed in" }, 401);
  let refusal: { body: object; status: number } | null;
  try {
    refusal = await deps.mfaRefusal(authorization!);
  } catch (err) {
    console.error(`${fn} two-step check failed: ${errorTag(err)}`);
    return json({ error: "Sign-in check is unavailable, please try again" }, 503);
  }
  return refusal ? json(refusal.body, refusal.status) : userId;
}

// Reads auth.getUser()'s result: the user's id; null when the token is bad, expired or missing
// (auth answers 4xx); throws when auth is down or unreachable (5xx, network: status 0 or none).
export function userIdFrom(result: {
  data: { user: { id: string } | null };
  error: { status?: number } | null;
}): string | null {
  const { data, error } = result;
  if (error && !(error.status && error.status < 500)) throw error;
  return error ? null : data.user?.id ?? null;
}
