// The refresh-recurring request handler, apart from Deno.serve so it can be tested.
import type { Db } from "../_shared/batch-update.ts";
import type { Reply } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { type CallerDeps, callerOrReply } from "../_shared/caller.ts";
import { detectUser } from "../_shared/detect-recurring-job.ts";
import type { Rpc } from "../_shared/batch-update.ts";

export interface Deps extends CallerDeps {
  admin(): Db; // service-role reads, scoped to the caller by detectUser
  rpc: Rpc; // service-role upsert_detected_streams
  today(): string; // YYYY-MM-DD, like the scheduled run
  now(): number; // ms since epoch
}

// Every Subscriptions page open asks for a run; one per 5 s per user is plenty (short enough that
// "edit a transaction, then open the page" still shows the edit).
const WINDOW_MS = 5_000;

// When detection last ran for this user: every upsert_detected_streams call records it in
// recurring_detection_runs, rows or not. Never run (or a failed read) means no limit: the limit is best
// effort, so it never blocks a refresh on its own. Two calls at the same instant can both run.
async function lastRun(db: Db, userId: string): Promise<number | null> {
  const { data, error } = await db.from("recurring_detection_runs").select("last_run_at").eq("user_id", userId)
    .limit(1);
  if (error || !data?.length) return null;
  return Date.parse((data as { last_run_at: string }[])[0].last_run_at);
}

export const refreshHandler = (deps: Deps) => async (req: Request, json: Reply): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerOrReply(req, deps, json, "refresh-recurring");
  if (userId instanceof Response) return userId;
  const db = deps.admin();
  const last = await lastRun(db, userId).catch(() => null);
  // abs: a database clock a little ahead of this one still counts as "just ran".
  if (last !== null && Math.abs(deps.now() - last) < WINDOW_MS) {
    return json({ error: "Your subscriptions were just refreshed, please wait a few seconds" }, 429);
  }
  try {
    return json({ streams: await detectUser(db, deps.rpc, userId, deps.today()) });
  } catch (err) {
    console.error(`refresh-recurring failed: ${errorTag(err)}`);
    return json({ error: "Couldn't refresh your subscriptions, please try again" }, 500);
  }
};
