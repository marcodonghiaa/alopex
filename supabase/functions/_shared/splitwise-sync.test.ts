import { assertEquals } from "jsr:@std/assert@1.0.19";
import type { SwExpense, SwGroup } from "./splitwise-api.ts";
import { balancesFrom, classify, groupLabels, NON_GROUP, planSync } from "./splitwise-sync.ts";

const ME = 1;
const share = (user_id: number, paid: string, owed: string, first_name = `P${user_id}`) => ({
  user_id,
  paid_share: paid,
  owed_share: owed,
  user: { id: user_id, first_name },
});
const expense = (over: Partial<SwExpense> = {}): SwExpense => ({
  id: 100,
  group_id: 5,
  description: "Dinner",
  cost: "10.00",
  currency_code: "EUR",
  date: "2026-11-02T13:00:00Z",
  updated_at: "2026-11-03T09:00:00Z",
  deleted_at: null,
  payment: false,
  users: [share(ME, "0.00", "3.33"), share(2, "10.00", "3.34"), share(3, "0.00", "3.33")],
  ...over,
});
const labels = new Map([[5, "Flat"], [0, NON_GROUP]]);
const base = { splitwise_id: 100, group_name: "Flat", booking_date: "2026-11-02", description: "Dinner", currency: "EUR", splitwise_updated_at: "2026-11-03T09:00:00Z" };

Deno.test("someone else paid: my owed share, exact on an odd-cent 3-way split", () => {
  assertEquals(classify(expense(), ME, labels), { type: "share", row: { ...base, category: null, amount: "3.33" } });
});

Deno.test("I paid alone: review paid_by_me with my share and what I paid", () => {
  const e = expense({ users: [share(ME, "10.00", "3.34"), share(2, "0.00", "3.33"), share(3, "0.00", "3.33")] });
  assertEquals(classify(e, ME, labels), {
    type: "review",
    row: { ...base, kind: "paid_by_me", cost: "10.00", my_share: "3.34", my_paid: "10.00" },
  });
});

Deno.test("I paid for others only: review with a zero share", () => {
  const e = expense({ users: [share(ME, "10.00", "0.00"), share(2, "0.00", "10.00")] });
  assertEquals(classify(e, ME, labels), {
    type: "review",
    row: { ...base, kind: "paid_by_me", cost: "10.00", my_share: "0.00", my_paid: "10.00" },
  });
});

Deno.test("two payers including me: review multi_payer", () => {
  const e = expense({ users: [share(ME, "6.00", "5.00"), share(2, "4.00", "5.00")] });
  assertEquals(classify(e, ME, labels), {
    type: "review",
    row: { ...base, kind: "multi_payer", cost: "10.00", my_share: "5.00", my_paid: "6.00" },
  });
});

Deno.test("settle-ups: out when I paid, in when I received, never spending", () => {
  const out = expense({ payment: true, cost: "25.00", users: [share(ME, "25.00", "0.00"), share(2, "0.00", "25.00")] });
  assertEquals(classify(out, ME, labels), {
    type: "review",
    row: { ...base, kind: "settle_out", cost: "25.00", my_share: "25.00", my_paid: "25.00", counterparty: "P2" },
  });
  const inn = expense({ payment: true, cost: "25.00", users: [share(2, "25.00", "0.00"), share(ME, "0.00", "25.00")] });
  assertEquals(classify(inn, ME, labels), {
    type: "review",
    row: { ...base, kind: "settle_in", cost: "25.00", my_share: "25.00", my_paid: "0.00", counterparty: "P2" },
  });
  const others = expense({ payment: true, users: [share(2, "25.00", "0.00"), share(3, "0.00", "25.00"), share(ME, "0.00", "0.00")] });
  assertEquals(classify(others, ME, labels), { type: "gone", id: 100 });
});

// polish-5 #11: the dashboard prefers a bank payment to (or from) the person the settle-up names.
Deno.test("settle-ups name the other person: first and last name, null when Splitwise sends none", () => {
  const named = (user: { id: number; first_name?: string | null; last_name?: string | null } | null) =>
    expense({ payment: true, cost: "25.00", users: [{ ...share(ME, "25.00", "0.00") }, { user_id: 2, paid_share: "0.00", owed_share: "25.00", user }] });
  const who = (e: SwExpense) => {
    const c = classify(e, ME, labels);
    return c.type === "review" ? c.row.counterparty : "not a review";
  };
  assertEquals(who(named({ id: 2, first_name: " Dana ", last_name: "Other" })), "Dana Other");
  assertEquals(who(named({ id: 2, first_name: "Dana", last_name: null })), "Dana");
  assertEquals(who(named(null)), null);
  const unreadable = expense({ payment: true, cost: "25.00", users: [share(ME, "25.00", "0.00"), { ...share(2, "0.00", "25.00"), owed_share: "x" }] });
  assertEquals(who(unreadable), null);
  // An expense, not a settle-up: no one to name.
  const paid = classify(expense({ users: [share(ME, "10.00", "5.00"), share(2, "0.00", "5.00")] }), ME, labels);
  assertEquals(paid.type === "review" && "counterparty" in paid.row, false);
});

Deno.test("not involved, or involved for nothing: gone (removed if we had it)", () => {
  assertEquals(classify(expense({ users: [share(2, "10.00", "5.00"), share(3, "0.00", "5.00")] }), ME, labels), { type: "gone", id: 100 });
  assertEquals(classify(expense({ users: [share(ME, "0.00", "0.00"), share(2, "10.00", "10.00")] }), ME, labels), { type: "gone", id: 100 });
  assertEquals(classify(expense({ users: undefined }), ME, labels), { type: "gone", id: 100 });
});

Deno.test("deleted in Splitwise: gone", () => {
  assertEquals(classify(expense({ deleted_at: "2026-11-04T00:00:00Z" }), ME, labels), { type: "gone", id: 100 });
});

Deno.test("friend expenses (no group) go under Splitwise's non-group label", () => {
  for (const group_id of [null, 0, undefined]) {
    const c = classify(expense({ group_id }), ME, labels);
    assertEquals(c.type === "share" && c.row.group_name, NON_GROUP);
  }
  // A group the labels don't know (left since): still a usable name.
  const c = classify(expense({ group_id: 77 }), ME, labels);
  assertEquals(c.type === "share" && c.row.group_name, "Splitwise group 77");
});

Deno.test("each expense keeps its own currency", () => {
  const usd = classify(expense({ currency_code: "USD" }), ME, labels);
  assertEquals(usd.type === "share" && usd.row.currency, "USD");
});

Deno.test("long or missing descriptions fit the table; spaces trimmed", () => {
  const long = classify(expense({ description: ` ${"é".repeat(400)} ` }), ME, labels);
  assertEquals(long.type === "share" && [...long.row.description].length, 300);
  const none = classify(expense({ description: null }), ME, labels);
  assertEquals(none.type === "share" && none.row.description, "");
});

// polish-2 #3: Postgres jsonb takes neither a NUL nor half a surrogate pair; one such text would fail
// that user's every sync. Whole emoji stay. (polish-2-fixes/item03-pg-*.log casts this to jsonb.)
Deno.test("texts lose NUL characters and lone surrogates, keep whole emoji", () => {
  const dirty = "Pi\u0000zza\ud800 \udc00night \u{1F355}";
  const c = classify(expense({ description: dirty }), ME, labels);
  assertEquals(c.type === "share" && c.row.description, "Pizza night \u{1F355}");
  const g = groupLabels([{ id: 9, name: `Flat${"\u0000"}\udfff`, members: [] }]);
  assertEquals(g.get(9), "Flat");
  const b = balancesFrom([{
    id: 5, name: "Flat",
    members: [{ id: ME, first_name: "Me", balance: [{ currency_code: "EUR", amount: "5.00" }] }, { id: 2, first_name: "B\u0000o\ud83c" }],
    original_debts: [{ from: 2, to: ME, amount: "5.00", currency_code: "EUR" }],
  }], ME, labels);
  assertEquals(b.map((r) => r.person).filter((p) => p !== "Me"), ["Bo"]);
});

Deno.test("unreadable expenses are skipped, not guessed", () => {
  for (const bad of [{ cost: "abc" }, { currency_code: "EURO" }, { date: "yesterday" }, { users: [share(ME, "0", "x")] }]) {
    assertEquals(classify(expense(bad as Partial<SwExpense>), ME, labels), { type: "skip", id: 100 });
  }
});

Deno.test("planSync sorts expenses into shares, review and gone, and keeps the newest updated_at", () => {
  const plan = planSync([
    expense({ id: 1, updated_at: "2026-11-03T09:00:00Z" }),
    expense({ id: 2, updated_at: "2026-11-05T09:00:00Z", users: [share(ME, "10.00", "5.00"), share(2, "0.00", "5.00")] }),
    expense({ id: 3, updated_at: "2026-11-04T09:00:00Z", deleted_at: "2026-11-04T09:00:00Z" }),
    expense({ id: 4, updated_at: "2026-11-01T00:00:00Z", cost: "x" }),
    expense({ id: 1, updated_at: "2026-11-03T09:00:00Z" }), // paging overlap: once only
  ], ME, labels);
  assertEquals(plan.shares.map((s) => s.splitwise_id), [1]);
  assertEquals(plan.review.map((r) => r.splitwise_id), [2]);
  assertEquals(plan.gone, [3]);
  assertEquals(plan.skipped, [4]);
  assertEquals(plan.cursor, "2026-11-05T09:00:00.000Z");
  assertEquals(plan.seen.sort(), [1, 2, 3, 4]);
});

Deno.test("planSync with nothing new has no cursor", () => {
  assertEquals(planSync([], ME, labels).cursor, null);
});

Deno.test("groupLabels: Splitwise's names, unique, within 100 characters", () => {
  const groups: SwGroup[] = [
    { id: 0, name: "Non-group expenses" },
    { id: 5, name: " Flat " },
    { id: 6, name: "Trip" },
    { id: 7, name: "Trip" },
    { id: 8, name: "" },
    { id: 9, name: "x".repeat(150) },
  ];
  const l = groupLabels(groups);
  assertEquals([l.get(0), l.get(5), l.get(6), l.get(7), l.get(8)], [NON_GROUP, "Flat", "Trip", "Trip (7)", "Splitwise group 8"]);
  assertEquals(l.get(9)!.length, 100);
});

Deno.test("balancesFrom: my net per currency and what I owe each person, from the unsimplified debts", () => {
  const groups: SwGroup[] = [
    {
      id: 5,
      name: "Flat",
      members: [
        { id: ME, first_name: "Ann", last_name: "Lee", balance: [{ currency_code: "EUR", amount: "7.50" }, { currency_code: "USD", amount: "-2.00" }] },
        { id: 2, first_name: "Bo", last_name: null, balance: [] },
        { id: 3, first_name: "Cy", balance: [] },
      ],
      original_debts: [
        { from: 2, to: ME, amount: "10.00", currency_code: "EUR" },
        { from: ME, to: 3, amount: "2.50", currency_code: "EUR" },
        { from: ME, to: 2, amount: "2.00", currency_code: "USD" },
        { from: 2, to: 3, amount: "1.00", currency_code: "EUR" }, // not mine
      ],
    },
    { id: 6, name: "Old", members: [{ id: 2, first_name: "Bo" }] }, // I'm not in it
    { id: 7, name: "Square", members: [{ id: ME, first_name: "Ann", balance: [{ currency_code: "EUR", amount: "0.0" }] }] },
  ];
  assertEquals(balancesFrom(groups, ME, groupLabels(groups)), [
    { group_name: "Flat", person: "Ann Lee", balance: "7.50", currency: "EUR", is_me: true },
    { group_name: "Flat", person: "Ann Lee", balance: "-2.00", currency: "USD", is_me: true },
    { group_name: "Flat", person: "Bo", balance: "-10.00", currency: "EUR", is_me: false },
    { group_name: "Flat", person: "Cy", balance: "2.50", currency: "EUR", is_me: false },
    { group_name: "Flat", person: "Bo", balance: "2.00", currency: "USD", is_me: false },
  ]);
});

Deno.test("balancesFrom: two people with the same name stay apart; debts add up per person", () => {
  const groups: SwGroup[] = [{
    id: 0,
    name: "Non-group expenses",
    members: [
      { id: ME, first_name: "Ann", balance: [{ currency_code: "EUR", amount: "3.00" }] },
      { id: 2, first_name: "Bo", balance: [] },
      { id: 3, first_name: "Bo", balance: [] },
    ],
    original_debts: [
      { from: 2, to: ME, amount: "1.00", currency_code: "EUR" },
      { from: 2, to: ME, amount: "1.00", currency_code: "EUR" },
      { from: 3, to: ME, amount: "1.00", currency_code: "EUR" },
      { from: 4, to: ME, amount: "0.00", currency_code: "EUR" },
    ],
  }];
  assertEquals(balancesFrom(groups, ME, groupLabels(groups)).map((b) => `${b.person}:${b.balance}`), ["Ann:3.00", "Bo (2):-2.00", "Bo (3):-1.00"]);
});

Deno.test("balancesFrom leaves out unreadable amounts and currencies", () => {
  const groups: SwGroup[] = [{
    id: 5,
    name: "Flat",
    members: [{ id: ME, first_name: "Ann", balance: [{ currency_code: "EUR", amount: "x" }, { currency_code: "bitcoin", amount: "1.00" }] }],
    original_debts: [{ from: 2, to: ME, amount: "1e9", currency_code: "EUR" }, { from: 2, to: ME, amount: "1.00", currency_code: "?" }],
  }];
  assertEquals(balancesFrom(groups, ME, groupLabels(groups)), []);
});

// polish-1 #9: the CSV import maps Splitwise's category (dashboard suggest-category.ts); the sync
// did not, so synced shares stayed uncategorized without an AI key.
Deno.test("Splitwise's category maps like the CSV import's; unknown, general or not spending stays empty", () => {
  const cat = (name: string | undefined) => {
    const c = classify(expense({ category: name === undefined ? undefined : { id: 1, name } }), ME, labels);
    return c.type === "share" ? c.row.category : "not a share";
  };
  assertEquals(cat("Dining out"), "Dine Out");
  assertEquals(cat("groceries"), "Groceries");
  assertEquals(cat("Taxi"), "Transports");
  assertEquals(cat("Rent"), "Housing");
  assertEquals(cat("Pharmacy"), "Health");
  assertEquals(cat("General"), null);
  assertEquals(cat("Taxes"), null, "a share is never a tax, income or transfer");
  assertEquals(cat(undefined), null);
});

// polish-1 #17: the cuts count characters, not UTF-16 units: an emoji (two units) on the boundary
// stays whole, and the cut text is what the database's char_length check counts.
Deno.test("description, group and person names are cut by characters, emoji on the boundary kept whole", () => {
  const desc = classify(expense({ description: `${"a".repeat(299)}😀tail` }), ME, labels);
  assertEquals(desc.type === "share" && desc.row.description, `${"a".repeat(299)}😀`);
  const accented = classify(expense({ description: "é".repeat(301) }), ME, labels);
  assertEquals(accented.type === "share" && accented.row.description, "é".repeat(300));
  const group = groupLabels([{ id: 9, name: `${"g".repeat(99)}😀more` }]).get(9)!;
  assertEquals([group, [...group].length], [`${"g".repeat(99)}😀`, 100]);
  const rows = balancesFrom([{
    id: 5,
    name: "Flat",
    members: [{ id: 1, first_name: "Ann", balance: [{ currency_code: "EUR", amount: "1.00" }] }, { id: 2, first_name: `${"p".repeat(99)}😀x` }],
    original_debts: [{ from: 2, to: 1, amount: "1.00", currency_code: "EUR" }],
  }], ME, labels);
  assertEquals(rows.find((r) => !r.is_me)?.person, `${"p".repeat(99)}😀`);
});

// H231: two groups with the same name were labelled in API order, so when Splitwise listed them
// the other way round, new shares of one landed under the other's label.
Deno.test("groupLabels: same-named groups get the same labels whatever order Splitwise lists them in", () => {
  const a = { id: 40, name: "Trip", members: [] };
  const b = { id: 7, name: "Trip", members: [] };
  const c = { id: 12, name: "Flat", members: [] };
  const one = groupLabels([a, b, c]);
  const other = groupLabels([c, b, a]);
  assertEquals([...one].sort(), [...other].sort());
  assertEquals([one.get(7), one.get(40), one.get(12)], ["Trip", "Trip (40)", "Flat"]);
});
