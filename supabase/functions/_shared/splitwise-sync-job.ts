// The sync-splitwise Edge Function's work, apart from Deno.serve so it can be tested: reads each
// connected user's Splitwise expenses and groups with their own API key and writes them in one
// splitwise_sync_apply call (in chunks for big accounts). Two callers:
//   * pg_cron with the project secret key: every connection that is ok or failed last time,
//     one user at a time, until the time budget runs out (the rest wait for the next run);
//   * the signed-in user's "Sync now" (their own connection only), or { preview: true } for a
//     dry run that writes nothing and returns the counts.
// Reads changes since the newest updated_at seen, minus a day of overlap; once a week (and the
// first time) everything, so expenses gone from Splitwise without a trace are removed too.
// shortcut: a deletion is seen early only if Splitwise bumps updated_at (unverified); otherwise
// the share goes at the weekly full check. Splitwise's notifications (type 2, expense deleted)
// could catch it sooner; not read yet.
// A refused key marks the connection needs_reconnect, and a 403 naming Splitwise Pro marks it
// pro_required (the cron skips both until the user connects again); a rate limit stops the run
// and keeps the status. Logs counts and error tags only.
import { type Db, PAGE_SIZE, readPages } from "./batch-update.ts";
import { errorTag } from "./log-safe.ts";
import type { Reply } from "./origins.ts";
import { type CallerDeps, callerOrReply } from "./caller.ts";
import { type SplitwiseClient, SplitwiseApiError, SplitwiseAuthError, SplitwiseProRequiredError, SplitwiseRateLimitError } from "./splitwise-api.ts";
import { balancesFrom, groupLabels, planSync } from "./splitwise-sync.ts";

const DAY = 86_400_000;
const OVERLAP_MS = DAY;
const FULL_EVERY_MS = 7 * DAY;
const CHUNK = 5000; // splitwise_sync_apply's limit per array
const MAX_SURE_GONE = 10; // a full check may always remove this many
const CONNECTION_COLS = "user_id, splitwise_user_id, cursor_updated_at, last_full_check_at, last_synced_at";
// A 401 on a key that worked: revoked or regenerated, or (since 2026) a Splitwise Pro subscription
// that ended, which Splitwise answers the same way.
const RECONNECT = "Splitwise refused the API key, or your Splitwise Pro subscription ended. Connect again, or import a Splitwise file.";
const PRO_REQUIRED = "Splitwise needs an active Splitwise Pro subscription for API keys. Renew it and connect again, or import a Splitwise file.";

export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
export type Connection = {
  user_id: string;
  splitwise_user_id: number;
  cursor_updated_at: string | null;
  last_full_check_at: string | null;
  last_synced_at: string | null;
};
export type JobDeps = {
  db: Db; // service role
  rpc: Rpc; // service role
  client: (apiKey: string) => Pick<SplitwiseClient, "expenses" | "groups">;
  now: () => number;
};
export type Counts = { new: number; adopted: number; review: number; deleted: number };

export function needsFullCheck(c: Connection, now: number): boolean {
  return !c.cursor_updated_at || !c.last_full_check_at || now - Date.parse(c.last_full_check_at) > FULL_EVERY_MS;
}

// deno-lint-ignore no-explicit-any
async function allIds(query: () => any): Promise<number[]> {
  const rows = await readPages<{ splitwise_id: number }>((from, to) => query().order("splitwise_id").range(from, to));
  return rows.map((r) => r.splitwise_id);
}

/** One user's sync. Throws the Splitwise or database error as it is. */
export async function syncUser(deps: JobDeps, c: Connection, { preview }: { preview: boolean }) {
  const key = await deps.rpc("splitwise_read_key", { p_user: c.user_id });
  if (key.error) throw key.error;
  if (typeof key.data !== "string" || !key.data) throw new SplitwiseAuthError("No API key stored", null);
  const api = deps.client(key.data);
  const full = needsFullCheck(c, deps.now());
  const updatedAfter = full ? undefined : new Date(Date.parse(c.cursor_updated_at!) - OVERLAP_MS).toISOString();
  const expenses = await api.expenses({ updatedAfter });
  const groups = await api.groups();
  const labels = groupLabels(groups);
  const me = Number(c.splitwise_user_id);
  const plan = planSync(expenses, me, labels);
  const deleted = [...plan.gone];
  let held = 0;
  if (full) {
    const seen = new Set(plan.seen);
    const local = [
      ...await allIds(() => deps.db.from("splitwise_expenses").select("splitwise_id").eq("user_id", c.user_id).not("splitwise_id", "is", null)),
      ...await allIds(() => deps.db.from("splitwise_review").select("splitwise_id").eq("user_id", c.user_id)),
    ];
    const missing = [...new Set(local)].filter((id) => !seen.has(id));
    // A read cut short must not wipe what is stored: removing more than half (and more than 10)
    // is held back, and the connection says so. The rest of the sync goes on, and the full check
    // counts as done, so a real mass removal never blocks the sync (the next full check, a week
    // later, holds them again).
    if (missing.length > Math.max(MAX_SURE_GONE, new Set(local).size / 2)) held = missing.length;
    else deleted.push(...missing);
  }
  const balances = balancesFrom(groups, me, labels);
  const calls = Math.max(1, ...[plan.shares, plan.review, deleted].map((a) => Math.ceil(a.length / CHUNK)));
  const counts: Counts = { new: 0, adopted: 0, review: 0, deleted: 0 };
  for (let i = 0; i < calls; i++) {
    const last = i === calls - 1;
    const part = <T>(a: T[]) => a.slice(i * CHUNK, (i + 1) * CHUNK);
    const { data, error } = await deps.rpc("splitwise_sync_apply", {
      p_user: c.user_id,
      p_shares: part(plan.shares),
      p_review: part(plan.review),
      p_deleted: part(deleted),
      p_balances: last ? balances : null,
      p_cursor: last ? plan.cursor : null,
      p_full: last && full,
      p_preview: preview,
    });
    if (error) throw error;
    for (const k of Object.keys(counts) as Array<keyof Counts>) counts[k] += Number((data as Counts)?.[k] ?? 0);
  }
  if (held > 0) {
    console.error(`sync-splitwise: ${held} removals held back`);
    if (!preview) {
      const { error } = await deps.db.from("splitwise_connections")
        .update({ status: "error", last_error: `Splitwise sent far fewer expenses than Alopex has, so ${held} were not removed` })
        .eq("user_id", c.user_id);
      if (error) console.error(`sync-splitwise: status not saved: ${errorTag(error)}`);
    }
  }
  return { ...counts, skipped: plan.skipped.length, full, ...(held > 0 ? { held } : {}) };
}

type Outcome = "needs_reconnect" | "pro_required" | "error" | "rate_limited";

/** Records why a user's sync failed (never Splitwise's or the database's own words). */
async function markFailure(db: Db, user: string, err: unknown): Promise<Outcome> {
  if (err instanceof SplitwiseRateLimitError) return "rate_limited";
  const status: Outcome = err instanceof SplitwiseProRequiredError
    ? "pro_required"
    : err instanceof SplitwiseAuthError ? "needs_reconnect" : "error";
  const last_error = status === "pro_required" ? PRO_REQUIRED
    : status === "needs_reconnect" ? RECONNECT
    : err instanceof SplitwiseApiError ? err.message : `Sync failed (${errorTag(err)})`;
  const { error } = await db.from("splitwise_connections").update({ status, last_error }).eq("user_id", user);
  if (error) console.error(`sync-splitwise: status not saved: ${errorTag(error)}`);
  return status;
}

export async function runAllUsers(deps: JobDeps, timeLeft: () => boolean) {
  const result = { users: 0, failed: 0, needsReconnect: 0, skipped: 0, rateLimited: false, new: 0, adopted: 0, review: 0, deleted: 0 };
  const { data, error } = await deps.db.from("splitwise_connections").select(CONNECTION_COLS)
    .in("status", ["ok", "error"])
    // Longest since the last try first (H230): a run the wall clock killed never reaches
    // markFailure or last_synced_at, so ordering by success alone put that user first forever.
    .order("last_attempt_at", { ascending: true, nullsFirst: true })
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(PAGE_SIZE);
  if (error) {
    console.error(`sync-splitwise: connections read failed: ${errorTag(error)}`);
    return { ...result, failed: 1 };
  }
  // shortcut: one page of connections (1000), plenty for a self-hosted instance.
  const list = data as Connection[];
  for (const [i, c] of list.entries()) {
    if (!timeLeft()) {
      result.skipped = list.length - i;
      break;
    }
    const stamp = await deps.db.from("splitwise_connections").update({ last_attempt_at: new Date(deps.now()).toISOString() }).eq("user_id", c.user_id);
    if (stamp.error) console.error(`sync-splitwise: attempt time not saved: ${errorTag(stamp.error)}`);
    try {
      const counts = await syncUser(deps, c, { preview: false });
      result.users++;
      for (const k of ["new", "adopted", "review", "deleted"] as const) result[k] += counts[k];
    } catch (err) {
      const outcome = await markFailure(deps.db, c.user_id, err);
      console.error(`sync-splitwise: a user failed: ${errorTag(err)}`);
      if (outcome === "rate_limited") {
        // Splitwise wants a break: everyone left waits for the next run.
        result.rateLimited = true;
        result.skipped = list.length - i - 1;
        break;
      }
      if (outcome === "needs_reconnect" || outcome === "pro_required") result.needsReconnect++;
      else result.failed++;
    }
  }
  return result;
}

export type HandlerDeps = JobDeps & CallerDeps & {
  isServer(req: Request): boolean; // the project secret key on apikey (pg_cron)
  timeLeft(): boolean;
};

export const syncNowHandler = (deps: HandlerDeps) => async (req: Request, json: Reply): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (deps.isServer(req)) {
    const result = await runAllUsers(deps, deps.timeLeft);
    console.log(`sync-splitwise: ${JSON.stringify(result)}`);
    return json(result, result.failed > 0 ? 500 : 200);
  }

  const userId = await callerOrReply(req, deps, json, "sync-splitwise");
  if (userId instanceof Response) return userId;

  const body = await req.json().catch(() => null);
  const preview = body?.preview === true;
  // Claimed before any work, a failed run's included: Sync now and its preview, once a minute each.
  // Saving a new key (reconnect) frees both, so a run refused for the old key doesn't hold it back.
  const attempt = await deps.rpc("splitwise_attempt", { p_user: userId, p_kind: preview ? "preview" : "sync", p_max: 1, p_window: "1 minute" });
  if (attempt.error) {
    console.error(`sync-splitwise: attempt check failed: ${errorTag(attempt.error)}`);
    return json({ error: "Couldn't sync with Splitwise. Try again later." }, 502);
  }
  if (attempt.data !== true) return json({ error: "Synced a moment ago. Try again in a minute." }, 429);
  const { data, error } = await deps.db.from("splitwise_connections").select(CONNECTION_COLS).eq("user_id", userId).limit(1);
  if (error) {
    console.error(`sync-splitwise: connection read failed: ${errorTag(error)}`);
    return json({ error: "Couldn't sync with Splitwise. Try again later." }, 502);
  }
  const c = (data as Connection[])[0];
  if (!c) return json({ error: "Splitwise is not connected" }, 404);
  try {
    return json(await syncUser(deps, c, { preview }));
  } catch (err) {
    console.error(`sync-splitwise: sync now failed: ${errorTag(err)}`);
    // A dry run changes nothing, its failure included; a refused key fails the real sync too.
    const outcome = preview && !(err instanceof SplitwiseAuthError)
      ? (err instanceof SplitwiseRateLimitError ? "rate_limited" : "error")
      : await markFailure(deps.db, userId, err);
    if (outcome === "needs_reconnect") return json({ error: RECONNECT, code: "needs_reconnect" }, 409);
    if (outcome === "pro_required") return json({ error: PRO_REQUIRED, code: "pro_required" }, 409);
    if (outcome === "rate_limited") return json({ error: "Splitwise asked to slow down. Try again later." }, 429);
    return json({ error: "Couldn't sync with Splitwise. Try again later." }, 502);
  }
};
