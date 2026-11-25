// "Apply to past transactions" on the dashboard's Rules page: re-runs your current rules over
// rows the AI or an earlier rule categorized, and rows nothing categorized yet. Hand-set categories (category_source 'manual' or
// 'legacy') are never read and the update guards on the same column (see planRuleReapply).
// db is the service-role client (so the hand-edit trigger doesn't mark these rows 'manual');
// every read and write is scoped to userId.
import { applyGroupedUpdates, type Db, readPages } from "./batch-update.ts";
import { fetchRules, planRuleReapply, planRuleRetire, REAPPLY_SOURCES, type Rule } from "./rules.ts";

const SAMPLE_SIZE = 5;

// Some updates failed; the others are saved. Running it again is safe: it only plans what's left.
export class PartialApplyError extends Error {}

interface ReapplyResult {
  changes: number;
  sample: Array<{ name: string; from: string | null; to: string | null }>;
}

// apply=false is the preview: same plan, nothing written. With `retired` (a rule you just
// deleted), only the rows that rule filed and no remaining rule explains are planned, back to
// uncategorized (see planRuleRetire); to is null in the sample.
export async function reapplyRules(db: Db, userId: string, apply: boolean, retired?: Rule): Promise<ReapplyResult> {
  const rules = await fetchRules(db, "set_category", userId);
  if (!retired && !rules?.length) return { changes: 0, sample: [] };

  // Read every page first, then write: updates never shift the pages still to be read.
  // deno-lint-ignore no-explicit-any
  const rows: any[] = await readPages((from, to) => {
    let query = db
      .from("transactions")
      .select("user_id, account_uid, entry_reference, creditor_name, remittance_info, category, category_source")
      .eq("user_id", userId)
      .is("deleted_at", null);
    // A deleted rule can only have filed rule rows in its own category: read just those.
    query = retired
      ? query.eq("category_source", "rule").eq("category", retired.set_category)
      // Never-categorized rows too (source null): the ones a new user writes rules for (e2e #18).
      : query.or(`category_source.is.null,category_source.in.(${REAPPLY_SOURCES.join(",")})`);
    return query.order("account_uid").order("entry_reference").range(from, to);
  });

  const items = retired
    ? planRuleRetire(rows, { ...retired, user_id: userId }, rules)
    : planRuleReapply(rows, rules);
  const byKey = new Map(rows.map((r) => [`${r.account_uid}\u0000${r.entry_reference}`, r]));
  const sample = items.slice(0, SAMPLE_SIZE).map((item) => {
    const row = byKey.get(`${item.account_uid}\u0000${item.entry_reference}`);
    return { name: row.creditor_name || row.remittance_info || "", from: row.category, to: item.update.category as string | null };
  });
  if (apply) {
    const failed = await applyGroupedUpdates(db, items, userId);
    if (failed) throw new PartialApplyError(`${failed} update(s) failed`);
  }
  return { changes: items.length, sample };
}
