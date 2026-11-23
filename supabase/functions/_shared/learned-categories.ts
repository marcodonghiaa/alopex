// What you set by hand is the best guess for the next
// transaction from the same merchant: before the AI, a new row takes the category you most
// recently chose for that merchant's other rows (category_source 'manual'). Rules still come first.
import type { Db } from "./batch-update.ts";

const PAGE = 1000;
const CHUNK_SIZE = 50; // keeps the `in (...)` request URL well under proxy limits, as in batch-update.ts

// A choice holds for one merchant name in one direction: on a card refund the bank puts the
// account holder in creditor_name, so a pick on a credit must not spread to debits (H073).
export const learnedKey = (name: string | null | undefined, direction: string | null | undefined) => `${direction ?? ""}|${name}`;

// Most recent hand-set category per merchant, for one user and the merchants in `names`.
// ponytail: pages through every matching hand-set row with no time check; one batch's merchants.
export async function fetchLearned(db: Db, userId: string, names: Array<string | null | undefined>) {
  const unique = [...new Set(names.filter(Boolean))];
  const learned = new Map<string, string>();
  // Each name is in one chunk only, so newest first within a chunk is newest per name.
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE);
    for (let from = 0;; from += PAGE) {
      const { data, error } = await db
        .from("transactions")
        .select("creditor_name, credit_debit_indicator, category, booking_date")
        .eq("user_id", userId)
        .eq("category_source", "manual")
        .in("creditor_name", chunk)
        .not("category", "is", null)
        .is("deleted_at", null)
        .order("booking_date", { ascending: false })
        .order("entry_reference", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      for (const r of data) {
        const key = learnedKey(r.creditor_name, r.credit_debit_indicator);
        if (!learned.has(key)) learned.set(key, r.category);
      }
      if (data.length < PAGE) break;
    }
  }
  return learned;
}

// Rows whose merchant has a learned category, and the rest (left for the AI).
type Keyed = { creditor_name?: string | null; credit_debit_indicator?: string | null };
const keyOf = (r: Keyed) => learnedKey(r.creditor_name, r.credit_debit_indicator);

export function applyLearned<T extends Keyed>(rows: T[], learned: Map<string, string>) {
  const matched: Array<{ row: T; category: string }> = [];
  const unmatched: T[] = [];
  for (const row of rows) {
    const category = row.creditor_name ? learned.get(keyOf(row)) : undefined;
    if (category) matched.push({ row, category });
    else unmatched.push(row);
  }
  return { matched, unmatched };
}

// The update for a learned row. A learned Transfer also leaves spending and income: the flow
// step reads the category (flow.ts), after your flow rules, and never over a flow you set.
export const learnedUpdate = (category: string): Record<string, string> => ({ category, category_source: "rule" });

// AI-chosen rows that disagree with what you set by hand for the same merchant. Only rows the
// AI categorized are ever changed: hand-set and rule rows stay as they are.
export function planRelearn<T extends Keyed & { category?: string | null; category_source?: string | null }>(
  aiRows: T[],
  learned: Map<string, string>,
) {
  return aiRows
    .filter((r) => r.category_source === "ai" && r.creditor_name && learned.has(keyOf(r)))
    .filter((r) => learned.get(keyOf(r)) !== r.category)
    .map((r) => ({ row: r, category: learned.get(keyOf(r))! }));
}
