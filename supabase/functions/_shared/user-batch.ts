// The jobs run with the service role and send bank-provided text to
// an LLM. Mixing users in one batch lets text one user receives (a payer controls the payment
// reference) influence how other users' rows are labelled, so each batch is scoped to one user.
import type { Db } from "./batch-update.ts";
import { createStallGuard } from "./stall-guard.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

// excludeUserIds: users to skip (e.g. ones whose rows keep failing), so they can't block the rest.
export async function fetchBatchForOneUser(
  db: Db,
  { table = "transactions", select, nullColumn, limit, excludeUserIds = new Set<string>() }:
    { table?: string; select: string; nullColumn: string; limit: number; excludeUserIds?: Set<string> },
): Promise<Row[]> {
  const pending = (cols: string) => {
    const q = db.from(table).select(cols).is(nullColumn, null);
    return excludeUserIds.size > 0 ? q.not("user_id", "in", `(${[...excludeUserIds].join(",")})`) : q;
  };

  const { data: first, error: firstError } = await pending("user_id").limit(1);
  if (firstError) throw firstError;
  if (!first || first.length === 0) return [];

  const { data, error } = await pending(`user_id, ${select}`).eq("user_id", first[0].user_id).limit(limit);
  if (error) throw error;
  return data;
}

// One user's batch at a time for `handle` (the AI step) until none is left or time runs out. A
// batch that comes back unchanged is a stall: that user is skipped for the rest of the run.
// Returns how many rows were handled, not counting a batch that came back unchanged (it filled
// nothing, H252: counted, it made post-sync's catch-up re-send it for up to 10 rounds). progress
// holds the same count as it goes, for a caller that reports it even when handle throws.
// stallKey: the row as the stall guard keys it.
export async function aiBatches(
  db: Db,
  query: { table?: string; select: string; nullColumn: string; limit: number },
  timeLeft: () => boolean,
  handle: (rows: Row[]) => Promise<void>,
  stallKey: (r: Row) => { user_id: string; account_uid: string; entry_reference: string } = (r) => r as never,
  progress = { rows: 0 },
): Promise<number> {
  const stalls = createStallGuard();
  while (timeLeft()) {
    const rows = await fetchBatchForOneUser(db, { ...query, excludeUserIds: stalls.stuckUserIds });
    if (rows.length === 0) break;
    if (stalls.isStalled(rows.map(stallKey))) {
      console.warn("No progress for one user, skipping them for this run.");
      progress.rows -= rows.length; // the same rows as the batch before: it filled none of them
      continue;
    }
    await handle(rows);
    progress.rows += rows.length;
  }
  return progress.rows;
}

// Walks every transaction whose `nullColumn` is still null, for deterministic work that sends
// nothing to an LLM (rules, transfer defaults), so it can span users. `handlePage` returns how
// many rows it filled in: those leave the result set, so the next page starts that much earlier.
export async function walkNullRows(
  db: Db,
  { select, nullColumn, pageSize = 1000, handlePage, timeLeft = () => true }: {
    select: string;
    nullColumn: string;
    pageSize?: number;
    handlePage: (rows: Row[]) => Promise<number>;
    timeLeft?: () => boolean;
  },
): Promise<number> {
  let offset = 0;
  let total = 0;
  while (timeLeft()) {
    const { data, error } = await db
      .from("transactions")
      .select(select)
      .is(nullColumn, null)
      .order("account_uid")
      .order("entry_reference")
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (data.length === 0) return total;
    const filled = await handlePage(data);
    total += filled;
    offset += data.length - filled;
    if (data.length < pageSize) return total;
  }
  return total;
}

// The rows as the AI sees them, and its answer's entry_reference -> the row it means. The key is
// (account_uid, entry_reference), so one reference can sit on two of a user's accounts: those
// get a batch-local "<ref>#<n>" so each answer lands on its own row (H074).
export function aiRefs<T extends { account_uid: string; entry_reference: string }>(rows: T[]) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.entry_reference, (counts.get(r.entry_reference) ?? 0) + 1);
  const byRef = new Map<string, T>();
  const sent = rows.map((r, i) => {
    const ref = counts.get(r.entry_reference)! > 1 ? `${r.entry_reference}#${i}` : r.entry_reference;
    byRef.set(ref, r);
    return ref === r.entry_reference ? r : { ...r, entry_reference: ref };
  });
  return { sent, byRef };
}
