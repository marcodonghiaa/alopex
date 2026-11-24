import { assertEquals } from "jsr:@std/assert@1.0.19";
import { applyRules, fetchRules, matchRule, planRuleReapply, type Rule } from "./rules.ts";
import cases from "./rules.cases.json" with { type: "json" };

const rule = (over: Partial<Rule> = {}): Rule => ({
  user_id: "u1", match_field: "creditor_name", match_text: "netflix", set_category: "Entertainment", set_transaction_type: null, ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  user_id: "u1", account_uid: "a1", entry_reference: "r1", creditor_name: "NETFLIX.COM", remittance_info: "",
  category: "Others", category_source: "ai", ...over,
});

Deno.test("applyRules splits rows into matched and unmatched, first rule wins", () => {
  const { matched, unmatched } = applyRules([row(), row({ creditor_name: "Lidl" })], [rule(), rule({ set_category: "Services" })]);
  assertEquals(matched.length, 1);
  assertEquals(matched[0].rule.set_category, "Entertainment");
  assertEquals(unmatched.length, 1);
});

Deno.test("a rule never matches another user's row", () => {
  assertEquals(applyRules([row({ user_id: "u2" })], [rule()]).matched.length, 0);
});

Deno.test('a rule on "any" field matches the remittance too; a rule with no text never matches', () => {
  assertEquals(applyRules([row({ creditor_name: "Card", remittance_info: "netflix monthly" })], [rule({ match_field: "any" })]).matched.length, 1);
  assertEquals(applyRules([row()], [rule({ match_text: null })]).matched.length, 0);
});

Deno.test("reapply plans a category change for an AI-set row", () => {
  assertEquals(planRuleReapply([row()], [rule()]), [{
    account_uid: "a1", entry_reference: "r1", update: { category: "Entertainment", category_source: "rule" },
    guardColumn: "category_source", guardIn: ["ai", "rule"],
  }]);
});

Deno.test("reapply never plans a change for manual or legacy rows, same category, no match or no category", () => {
  assertEquals(planRuleReapply([row({ category_source: "manual" }), row({ entry_reference: "r2", category_source: "legacy" })], [rule()]), []);
  assertEquals(planRuleReapply([row({ category: "Entertainment", category_source: "rule" })], [rule()]), []);
  assertEquals(planRuleReapply([row({ creditor_name: "Lidl" })], [rule()]), []);
  assertEquals(planRuleReapply([row()], [rule({ set_category: null })]), []);
});

Deno.test("contains (default for older rules) matches anywhere; word and exact do not over-match", () => {
  const barclays = row({ creditor_name: "BARCLAYS UK" });
  assertEquals(matchRule(barclays, rule({ match_text: "bar" })), true);
  assertEquals(matchRule(barclays, rule({ match_text: "bar", match_mode: "word" })), false);
  assertEquals(matchRule(row({ creditor_name: "PAYPAL *BAR-ROMA" }), rule({ match_text: "bar", match_mode: "word" })), true);
  assertEquals(matchRule(row({ creditor_name: "Bàrbara" }), rule({ match_text: "bàr", match_mode: "word" })), false);
  assertEquals(matchRule(row({ creditor_name: "AXB" }), rule({ match_text: "a.b", match_mode: "word" })), false);
  assertEquals(matchRule(row({ creditor_name: "NETFLIX " }), rule({ match_text: " Netflix ", match_mode: "exact" })), true);
  assertEquals(matchRule(row({ creditor_name: "NETFLIX.COM" }), rule({ match_text: "netflix", match_mode: "exact" })), false);
  assertEquals(matchRule(row(), rule({ match_text: "  " })), false);
});

Deno.test("word treats accented letters as letters, in either Unicode form", () => {
  const word = (text: string) => rule({ match_text: text, match_mode: "word" });
  assertEquals(matchRule(row({ creditor_name: "Café Roma" }), word("caf")), false);
  assertEquals(matchRule(row({ creditor_name: "Élan Vital" }), word("lan")), false);
  assertEquals(matchRule(row({ creditor_name: "Cafe\u0301 Roma" }), word("café")), true); // decomposed é
});

// H106: same cases as alopex-web's copy, so a rule matches the same names in the sync and the dashboard.
Deno.test("matches names the same way as the dashboard: case, accents and apostrophes ignored", () => {
  for (const [name, text, mode, expected] of cases.match) {
    const r = rule({ match_text: text as string, match_mode: mode as string });
    assertEquals(matchRule(row({ creditor_name: name }), r), expected, `${name} / ${text} / ${mode}`);
  }
});

Deno.test("word checks a boundary only on letter or digit edges", () => {
  assertEquals(matchRule(row({ creditor_name: "AMAZON.IT" }), rule({ match_text: "amazon.", match_mode: "word" })), true);
  assertEquals(matchRule(row({ creditor_name: "PAYPAL*NETFLIX" }), rule({ match_text: "*netflix", match_mode: "word" })), true);
});

Deno.test("contains keeps the text as typed, spaces included", () => {
  assertEquals(matchRule(row(), rule({ match_text: " netflix" })), false);
});

Deno.test("reapply leaves Transfer alone, into it or out of it", () => {
  assertEquals(planRuleReapply([row({ category: "Transfer" })], [rule()]), []);
  assertEquals(planRuleReapply([row()], [rule({ set_category: "Transfer" })]), []);
});

// Polish pass 2 #1: building a regex per row × rule made 20k rows × 200 rules take ~7 s.
Deno.test("each rule builds its matcher once, not once per row", () => {
  const Original = RegExp;
  let built = 0;
  globalThis.RegExp = new Proxy(Original, { construct: (Target, args) => (built++, Reflect.construct(Target, args)) });
  try {
    const rows = Array.from({ length: 100 }, (_, i) => row({ entry_reference: `r${i}`, creditor_name: "Lidl" }));
    const rules = [rule({ match_text: "bar", match_mode: "word" }), rule({ match_text: "spotify", match_mode: "word" })];
    planRuleReapply(rows, rules);
    applyRules(rows, rules);
  } finally {
    globalThis.RegExp = Original;
  }
  assertEquals(built <= 4, true, `built ${built} regexes for 2 rules`);
});

// Polish pass 5 #4: the sync sets a rule's type along with its category (categorize.ts), so
// "Apply to past" must too, or past and new rows end up with different types.
Deno.test("planRuleReapply also sets the rule's type when it changes the category", () => {
  assertEquals(planRuleReapply([row()], [rule({ set_transaction_type: "Subscription" })])[0].update, {
    category: "Entertainment", category_source: "rule", transaction_type: "Subscription",
  });
});

Deno.test("reapply also files never-categorized rows, guarded on still being empty (e2e #18)", () => {
  assertEquals(planRuleReapply([row({ category: null, category_source: null })], [rule()]), [{
    account_uid: "a1", entry_reference: "r1", update: { category: "Entertainment", category_source: "rule" },
    guardColumn: "category_source",
  }]);
});

Deno.test("fetchRules: the match columns plus the action, rules that set it, oldest first", async () => {
  const asked: unknown[][] = [];
  const db = {
    from: (t: string) => {
      asked.push(["from", t]);
      const q = {
        select: (c: string) => (asked.push(["select", c]), q),
        eq: (c: string, v: string) => (asked.push(["eq", c, v]), q),
        not: (c: string, op: string, v: null) => (asked.push(["not", c, op, v]), q),
        order: (c: string, o: { ascending: boolean }) => (asked.push(["order", c, o.ascending]), q),
        then: (ok: (r: unknown) => void) => ok({ data: [{ id: 1 }], error: null }),
      };
      return q;
    },
  };
  assertEquals(await fetchRules<unknown>(db, "set_category", "u1"), [{ id: 1 }]);
  assertEquals(asked, [
    ["from", "category_rules"],
    ["select", "user_id, match_field, match_text, match_mode, set_category, set_transaction_type"],
    ["eq", "user_id", "u1"],
    ["not", "set_category", "is", null],
    ["order", "priority", true],
    ["order", "created_at", true],
  ]);
  asked.length = 0;
  await fetchRules(db, "set_flow_type");
  assertEquals(asked.slice(1, 3), [["select", "user_id, match_field, match_text, match_mode, set_flow_type"], ["not", "set_flow_type", "is", null]]);
});
