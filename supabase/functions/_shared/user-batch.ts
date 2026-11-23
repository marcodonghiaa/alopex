// The jobs run with the service role and send bank-provided text to
// an LLM. Mixing users in one batch lets text one user receives (a payer controls the payment
// reference) influence how other users' rows are labelled, so each batch is scoped to one user.
import type { Db } from "./batch-update.ts";

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
