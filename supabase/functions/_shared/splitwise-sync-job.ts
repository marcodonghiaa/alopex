// The sync-splitwise Edge Function's work, apart from Deno.serve so it can be tested: reads each
// connected user's Splitwise expenses and groups with their own API key and writes them in one
// splitwise_sync_apply call (in chunks for big accounts). Two callers:
//   * pg_cron with the project secret key: every connection that is ok or failed last time,
//     one user at a time, until the time budget runs out (the rest wait for the next run);
//   * the signed-in user's "Sync now" (their own connection only), or { preview: true } for a
//     dry run that writes nothing and returns the counts.
// Reads changes since the newest updated_at seen, minus a day of overlap; once a week (and the
// first time) everything, so expenses gone from Splitwise without a trace are removed too.
// A refused key marks the connection needs_reconnect (the cron skips it until the user connects
// again); a rate limit stops the run and keeps the status. Logs counts and error tags only.
import type { Db } from "./batch-update.ts";
import { errorTag } from "./log-safe.ts";
import type { Reply } from "./origins.ts";
import { type SplitwiseClient, SplitwiseApiError, SplitwiseAuthError, SplitwiseRateLimitError } from "./splitwise-api.ts";
import { balancesFrom, groupLabels, planSync } from "./splitwise-sync.ts";

const DAY = 86_400_000;
const OVERLAP_MS = DAY;
const FULL_EVERY_MS = 7 * DAY;
const CHUNK = 5000; // splitwise_sync_apply's limit per array
const PAGE = 1000; // PostgREST caps a response at 1000 rows
const SYNC_NOW_GAP_MS = 60_000;
const MAX_SURE_GONE = 10; // a full check may always remove this many
const CONNECTION_COLS = "user_id, splitwise_user_id, cursor_updated_at, last_full_check_at, last_synced_at";
const RECONNECT = "Splitwise refused the API key. Connect again with a new key.";

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
  const out: number[] = [];
  for (let from = 0;; from += PAGE) {
    const { data, error } = await query().order("splitwise_id").range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data as Array<{ splitwise_id: number }>).map((r) => r.splitwise_id));
    if (data.length < PAGE) return out;
  }
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
  if (full) {
    const seen = new Set(plan.seen);
    const local = [
      ...await allIds(() => deps.db.from("splitwise_expenses").select("splitwise_id").eq("user_id", c.user_id).not("splitwise_id", "is", null)),
      ...await allIds(() => deps.db.from("splitwise_review").select("splitwise_id").eq("user_id", c.user_id)),
    ];
    const missing = [...new Set(local)].filter((id) => !seen.has(id));
    // A read cut short must not wipe what is stored: removing more than half (and more than 10)
    // waits for a read that looks whole.
    if (missing.length > Math.max(MAX_SURE_GONE, new Set(local).size / 2)) {
      throw new SplitwiseApiError("Splitwise sent far fewer expenses than Alopex has, so nothing was removed");
    }
    deleted.push(...missing);
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
  return { ...counts, skipped: plan.skipped.length, full };
}

type Outcome = "needs_reconnect" | "error" | "rate_limited";

/** Records why a user's sync failed (never Splitwise's or the database's own words). */
async function markFailure(db: Db, user: string, err: unknown): Promise<Outcome> {
  if (err instanceof SplitwiseRateLimitError) return "rate_limited";
  const auth = err instanceof SplitwiseAuthError;
  const last_error = auth ? RECONNECT : err instanceof SplitwiseApiError ? err.message : `Sync failed (${errorTag(err)})`;
  const { error } = await db.from("splitwise_connections")
    .update({ status: auth ? "needs_reconnect" : "error", last_error })
    .eq("user_id", user);
  if (error) console.error(`sync-splitwise: status not saved: ${errorTag(error)}`);
  return auth ? "needs_reconnect" : "error";
}

export async function runAllUsers(deps: JobDeps, timeLeft: () => boolean) {
  const result = { users: 0, failed: 0, needsReconnect: 0, skipped: 0, rateLimited: false, new: 0, adopted: 0, review: 0, deleted: 0 };
  const { data, error } = await deps.db.from("splitwise_connections").select(CONNECTION_COLS)
    .in("status", ["ok", "error"]).order("last_synced_at", { ascending: true, nullsFirst: true }).limit(PAGE);
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
      if (outcome === "needs_reconnect") result.needsReconnect++;
      else result.failed++;
    }
  }
  return result;
}

export type HandlerDeps = JobDeps & {
  isServer(req: Request): boolean; // the project secret key on apikey (pg_cron)
  userIdFor(authorization: string): Promise<string | null>;
  mfaRefusal(authorization: string): Promise<{ body: object; status: number } | null>;
  timeLeft(): boolean;
};

export const syncNowHandler = (deps: HandlerDeps) => async (req: Request, json: Reply): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (deps.isServer(req)) {
    const result = await runAllUsers(deps, deps.timeLeft);
    console.log(`sync-splitwise: ${JSON.stringify(result)}`);
    return json(result, result.failed > 0 ? 500 : 200);
  }

  const authorization = req.headers.get("Authorization");
  let userId: string | null;
  let refusal: { body: object; status: number } | null = null;
  try {
    userId = authorization ? await deps.userIdFor(authorization) : null;
    if (userId) refusal = await deps.mfaRefusal(authorization!);
  } catch (err) {
    console.error(`sync-splitwise: sign-in check failed: ${errorTag(err)}`);
    return json({ error: "Sign-in check is unavailable, please try again" }, 503);
  }
  if (!userId) return json({ error: "Not signed in" }, 401);
  if (refusal) return json(refusal.body, refusal.status);

  const body = await req.json().catch(() => null);
  const preview = body?.preview === true;
  const { data, error } = await deps.db.from("splitwise_connections").select(CONNECTION_COLS).eq("user_id", userId).limit(1);
  if (error) {
    console.error(`sync-splitwise: connection read failed: ${errorTag(error)}`);
    return json({ error: "Couldn't sync with Splitwise. Try again later." }, 502);
  }
  const c = (data as Connection[])[0];
  if (!c) return json({ error: "Splitwise is not connected" }, 404);
  if (!preview && c.last_synced_at && deps.now() - Date.parse(c.last_synced_at) < SYNC_NOW_GAP_MS) {
    return json({ error: "Synced a moment ago. Try again in a minute." }, 429);
  }
  try {
    return json(await syncUser(deps, c, { preview }));
  } catch (err) {
    console.error(`sync-splitwise: sync now failed: ${errorTag(err)}`);
    // A dry run changes nothing, its failure included; a refused key fails the real sync too.
    const outcome = preview && !(err instanceof SplitwiseAuthError)
      ? (err instanceof SplitwiseRateLimitError ? "rate_limited" : "error")
      : await markFailure(deps.db, userId, err);
    if (outcome === "needs_reconnect") return json({ error: RECONNECT, code: "needs_reconnect" }, 409);
    if (outcome === "rate_limited") return json({ error: "Splitwise asked to slow down. Try again later." }, 429);
    return json({ error: "Couldn't sync with Splitwise. Try again later." }, 502);
  }
};
