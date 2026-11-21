// The refresh-recurring request handler, apart from Deno.serve so it can be tested.
import type { Db } from "../_shared/batch-update.ts";
import type { Reply } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { type CallerDeps, callerOrReply } from "../_shared/caller.ts";
import { detectUser, type Rpc } from "../_shared/detect-recurring-job.ts";

export interface Deps extends CallerDeps {
  admin(): Db; // service-role reads, scoped to the caller by detectUser
  rpc: Rpc; // service-role upsert_detected_streams
  today(): string; // YYYY-MM-DD, like the scheduled run
}

export const refreshHandler = (deps: Deps) => async (req: Request, json: Reply): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerOrReply(req, deps, json, "refresh-recurring");
  if (userId instanceof Response) return userId;
  try {
    return json({ streams: await detectUser(deps.admin(), deps.rpc, userId, deps.today()) });
  } catch (err) {
    console.error(`refresh-recurring failed: ${errorTag(err)}`);
    return json({ error: "Couldn't refresh your subscriptions, please try again" }, 500);
  }
};
