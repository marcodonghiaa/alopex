import { assertEquals } from "jsr:@std/assert@1.0.19";
import { applyLearned, fetchLearned, learnedUpdate, planRelearn } from "./learned-categories.ts";

// Regression: a merchant you had set to Housing by hand came back as Shopping on its next
// transaction, because the AI never saw your choices.
Deno.test("a new row takes the category you last set by hand for the same merchant", () => {
  const learned = new Map([["FOUND STUDY SOUTHSIDE", "Housing"]]);
  const { matched, unmatched } = applyLearned([
    { entry_reference: "r1", creditor_name: "FOUND STUDY SOUTHSIDE" },
    { entry_reference: "r2", creditor_name: "NEW SHOP" },
    { entry_reference: "r3", creditor_name: null },
  ], learned);
  assertEquals(matched.map((m) => [m.row.entry_reference, m.category]), [["r1", "Housing"]]);
  assertEquals(unmatched.map((r) => r.entry_reference), ["r2", "r3"]);
});

Deno.test("a learned row takes the category; the flow step handles Transfer", () => {
  assertEquals(learnedUpdate("Transfer"), { category: "Transfer", category_source: "rule" });
});

Deno.test("fetchLearned keeps the most recent hand-set category per merchant, for that user only", async () => {
  const calls: Record<string, unknown> = {};
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => ((calls[c] = v), q),
    in: (c: string, v: unknown) => ((calls[c] = v), q),
    not: () => q,
    is: () => q,
    order: () => q,
    range: async () => ({
      data: [
        { creditor_name: "A", category: "Housing", booking_date: "2026-10-01" },
        { creditor_name: "A", category: "Shopping", booking_date: "2026-09-01" },
      ],
      error: null,
    }),
  };
  const learned = await fetchLearned({ from: () => q }, "u1", ["A", "A", null]);
  assertEquals(learned.get("A"), "Housing");
  assertEquals([calls.user_id, calls.category_source, calls.creditor_name], ["u1", "manual", ["A"]]);
});

Deno.test("an AI row is corrected to your category; your own and rule rows never are", () => {
  const plan = planRelearn([
    { entry_reference: "ai-wrong", creditor_name: "FOUND STUDY", category: "Shopping", category_source: "ai" },
    { entry_reference: "ai-right", creditor_name: "FOUND STUDY", category: "Housing", category_source: "ai" },
    { entry_reference: "mine", creditor_name: "FOUND STUDY", category: "Shopping", category_source: "manual" },
    { entry_reference: "other", creditor_name: "OTHER", category: "Shopping", category_source: "ai" },
  ], new Map([["FOUND STUDY", "Housing"]]));
  assertEquals(plan.map((p) => [p.row.entry_reference, p.category]), [["ai-wrong", "Housing"]]);
});

// H011: one in() with hundreds of merchant names made a request URL past proxy limits, and the
// failed read stopped post-sync for every user. Names go in chunks of 50, like batch-update.ts.
Deno.test("fetchLearned asks for many merchants in chunks of 50 and keeps the newest choice for each", async () => {
  const names = Array.from({ length: 120 }, (_, i) => `M${i}`);
  const stored = names.flatMap((n) => [
    { creditor_name: n, category: `new-${n}`, booking_date: "2026-10-01" },
    { creditor_name: n, category: `old-${n}`, booking_date: "2026-09-01" },
  ]);
  const inLists: string[][] = [];
  const db = {
    from: () => {
      let list: string[] = [];
      const q = {
        select: () => q,
        eq: () => q,
        in: (_c: string, v: string[]) => ((list = v), inLists.push(v), q),
        not: () => q,
        is: () => q,
        order: () => q,
        range: async () => ({ data: stored.filter((r) => list.includes(r.creditor_name)), error: null }),
      };
      return q;
    },
  };
  const learned = await fetchLearned(db, "u1", names);
  assertEquals(inLists.map((l) => l.length), [50, 50, 20]);
  assertEquals(learned.size, 120);
  assertEquals([learned.get("M0"), learned.get("M119")], ["new-M0", "new-M119"]);
});
