// Splitwise shares without a
// category get one from the AI. A choice made in the import screen (including "Others") is never
// overwritten: every update is guarded on category being null. Without an AI key nothing happens.
import type { Db } from "./batch-update.ts";
import { CATEGORIES, guideFor } from "./categories.ts";
import { type Ask, UNTRUSTED_TEXT_NOTE } from "./gemini.ts";
import { errorTag } from "./log-safe.ts";
import { aiBatches } from "./user-batch.ts";

const BATCH_SIZE = 40;
// A share is shared everyday spending, so income, transfer and tax buckets are not offered.
const NOT_SHARED = new Set(["Income", "Transfer", "Taxes"]);
export const SPLITWISE_CATEGORIES = CATEGORIES.filter((c) => !NOT_SHARED.has(c));

type Share = { id: string; user_id: string; description?: string | null };

// Friends write the descriptions, so only id and description leave the server: no amounts,
// group name or user, and the model is told the text is untrusted.
export function buildSplitwisePrompt(rows: Share[]): string {
  return `You are categorizing shared household and trip expenses from a Splitwise group into exactly one of these categories: ${SPLITWISE_CATEGORIES.join(", ")}.

Category guide:
${guideFor(SPLITWISE_CATEGORIES)}

Descriptions are short, informal, often Italian or English, and may be a store name, a nickname or a person's name. Typical cases: Target, Trader Joe's ("tj"), "spesa" and grocery runs are Groceries; paper towels, soap, detergent pods, filters, toilet paper and other home supplies are Housing; Uber, Lyft, Waymo and bike rentals are Transports; use Others when the description gives no hint (for example only a person's name).

${UNTRUSTED_TEXT_NOTE}

Expenses (JSON array):
${JSON.stringify(rows.map((r) => ({ entry_reference: r.id, description: r.description })), null, 2)}

Return a JSON array of {"entry_reference": string, "category": string} for every expense above, same order, one entry each. category must be exactly one of the allowed categories.`;
}

// Keeps one valid answer per row we sent; anything else the model returned is ignored.
export function planSplitwiseUpdates(results: Array<Record<string, string>>, rows: Share[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const plan: Array<{ id: string; user_id: string; category: string }> = [];
  let invalid = 0;
  for (const { entry_reference, category } of results) {
    const row = byId.get(entry_reference);
    if (!row || seen.has(entry_reference)) continue;
    if (!SPLITWISE_CATEGORIES.includes(category)) {
      invalid++;
      continue;
    }
    seen.add(entry_reference);
    plan.push({ id: row.id, user_id: row.user_id, category });
  }
  if (invalid > 0) console.warn(`Skipping ${invalid} invalid category result(s).`);
  return plan;
}

async function applyPlan(db: Db, plan: Array<{ id: string; user_id: string; category: string }>) {
  const groups = new Map<string, { user_id: string; category: string; ids: string[] }>();
  for (const { id, user_id, category } of plan) {
    const key = `${user_id}|${category}`;
    if (!groups.has(key)) groups.set(key, { user_id, category, ids: [] });
    groups.get(key)!.ids.push(id);
  }
  for (const { user_id, category, ids } of groups.values()) {
    const { error } = await db
      .from("splitwise_expenses")
      .update({ category })
      .eq("user_id", user_id)
      .in("id", ids)
      .is("category", null);
    if (error) console.error(`Failed to categorize ${ids.length} Splitwise share(s): ${errorTag(error)}`);
  }
}

/** ask: null when there is no AI key. Returns how many shares were handled (see aiBatches). */
export async function categorizeSplitwise(db: Db, ask: Ask | null, timeLeft: () => boolean = () => true) {
  if (!ask) return { splitwise: 0, splitwiseAiFailed: false };
  const progress = { rows: 0 }; // kept here, not only returned by aiBatches, so a failed run still reports it
  try {
    await aiBatches(db, { table: "splitwise_expenses", select: "id, description", nullColumn: "category", limit: BATCH_SIZE }, timeLeft, async (rows) => {
      const shares = rows as Share[];
      await applyPlan(db, planSplitwiseUpdates(await ask(buildSplitwisePrompt(shares), "category", SPLITWISE_CATEGORIES), shares));
    }, (r) => ({ user_id: r.user_id, account_uid: "splitwise", entry_reference: r.id }), progress); // a share has no account_uid or entry_reference
    return { splitwise: progress.rows, splitwiseAiFailed: false };
  } catch (err) {
    console.error(`Splitwise categorization failed: ${errorTag(err)}`);
    return { splitwise: progress.rows, splitwiseAiFailed: true };
  }
}
