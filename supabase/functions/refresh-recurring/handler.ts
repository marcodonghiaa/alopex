// The refresh-recurring request handler, apart from Deno.serve so it can be tested.
import type { Db } from "../_shared/batch-update.ts";
import type { Reply } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { detectUser, type Rpc } from "../_shared/detect-recurring-job.ts";

export interface Deps {
  // Who signed this request; null for a bad or expired token, throws if auth can't be reached.
  userIdFor(authorization: string): Promise<string | null>;
  // The database's two-step sign-in check, asked with the caller's JWT (see _shared/mfa.ts).
  mfaRefusal(authorization: string): Promise<{ body: object; status: number } | null>;
  admin(): Db; // service-role reads, scoped to the caller by detectUser
  rpc: Rpc; // service-role upsert_detected_streams
  today(): string; // YYYY-MM-DD, like the scheduled run
}

export const refreshHandler = (deps: Deps) => async (req: Request, json: Reply): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authorization = req.headers.get("Authorization");
  let userId: string | null = null;
  try {
    userId = authorization ? await deps.userIdFor(authorization) : null;
  } catch (err) {
    console.error(`refresh-recurring auth check failed: ${errorTag(err)}`);
    return json({ error: "Sign-in check is unavailable, please try again" }, 503);
  }
  if (!userId) return json({ error: "Not signed in" }, 401);
  let refusal: { body: object; status: number } | null;
  try {
    refusal = await deps.mfaRefusal(authorization!);
  } catch (err) {
    console.error(`refresh-recurring two-step check failed: ${errorTag(err)}`);
    return json({ error: "Sign-in check is unavailable, please try again" }, 503);
  }
  if (refusal) return json(refusal.body, refusal.status);
  try {
    return json({ streams: await detectUser(deps.admin(), deps.rpc, userId, deps.today()) });
  } catch (err) {
    console.error(`refresh-recurring failed: ${errorTag(err)}`);
    return json({ error: "Couldn't refresh your subscriptions, please try again" }, 500);
  }
};
