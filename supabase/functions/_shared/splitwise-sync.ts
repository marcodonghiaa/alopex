// What one Splitwise API read means for Alopex, as plain data for splitwise_sync_apply. Pure: no
// database, no network. Integer cents throughout; amounts leave as exact decimal strings.
//
//   my paid | my owed | other payers | payment | →
//   0       | > 0     | any          | no      | share: my owed share counts as spending
//   > 0     | any     | none         | no      | review paid_by_me (link the bank payment, or count it)
//   > 0     | any     | some         | no      | review multi_payer
//   > 0     | any     | any          | yes     | review settle_out (a transfer out of my bank)
//   0       | > 0     | any          | yes     | review settle_in (a transfer into my bank)
//   0       | 0       |              |         | gone: not mine (removed if we had it)
//   deleted_at set                             | gone
//
// Expenses outside any group (with friends) all go under Splitwise's own label for them.
// A share's category comes from Splitwise's own, mapped as the CSV import maps it; when that
// says nothing, it is left empty and post-sync fills it (_shared/splitwise.ts).
import { CATEGORIES } from "./categories.ts";
import { SPLITWISE_CATEGORIES } from "./splitwise.ts";
import { centsToDecimal, personName, type SwExpense, type SwGroup, type SwUser, toCents } from "./splitwise-api.ts";

export const NON_GROUP = "Non-group expenses";
const MAX_GROUP = 100;
const MAX_DESCRIPTION = 300;
const MAX_NAME = 200;
const MAX_CENTS = 100_000_000_000; // the tables allow amounts below 1e9

export type ShareRow = {
  splitwise_id: number;
  group_name: string;
  booking_date: string;
  description: string;
  category: string | null;
  amount: string;
  currency: string;
  splitwise_updated_at: string | null;
};
export type ReviewKind = "paid_by_me" | "multi_payer" | "settle_out" | "settle_in";
export type ReviewRow = Omit<ShareRow, "category" | "amount"> & {
  kind: ReviewKind;
  cost: string;
  my_share: string;
  my_paid: string;
  /** A settle-up's other person, as Splitwise names them (the dashboard prefers their payment). */
  counterparty?: string | null;
};
export type BalanceRow = { group_name: string; person: string; balance: string; currency: string; is_me: boolean };
export type Classified =
  | { type: "share"; row: ShareRow }
  | { type: "review"; row: ReviewRow }
  | { type: "gone"; id: number }
  | { type: "skip"; id: number };

// Like the dashboard's suggestCategory (src/lib/import/suggest-category.ts) for the category column
// of a Splitwise file: an app category by name, else the first keyword group. Only the groups a
// share can have; the dashboard has more (Taxes, Income, Transfer) and defaults to Others.
const KEYWORDS: Array<[string, RegExp]> = [
  ["Groceries", /\b(grocer|supermerc|spesa|market)/],
  ["Dine Out", /\b(restaurant|ristorant|dining|bar\b|cafe|caffe|pizz|takeaway)/],
  ["Housing", /\b(rent|affitto|mutuo|mortgage|condomin)/],
  ["Transports", /\b(uber|taxi|train|treno|bus\b|fuel|benzina|transport|parking|parcheggio|metro)/],
  ["Health", /\b(pharmac|farmac|doctor|medic|dentist|salute|health|gym|palestra)/],
  ["Entertainment", /\b(netflix|spotify|cinema|movie|entertain|svago|game|subscri)/],
  ["Experiences", /\b(travel|viagg|hotel|holiday|vacanz|concert|event)/],
  ["Shopping", /\b(shop|cloth|abbigliament|amazon)/],
  ["Services", /\b(bill|bolletta|utilit|insurance|assicur|internet|phone|telefon)/],
];
export function categoryFrom(name: string | null | undefined): string | null {
  const s = (name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  if (!s) return null;
  const found = CATEGORIES.find((c) => c.toLowerCase() === s) ?? KEYWORDS.find(([, re]) => re.test(s))?.[0] ?? null;
  // A share is everyday spending (SPLITWISE_CATEGORIES); "Others" says nothing.
  return found && found !== "Others" && SPLITWISE_CATEGORIES.includes(found) ? found : null;
}

// Postgres jsonb takes neither a NUL nor half a surrogate pair: dropped, so one odd text cannot fail every sync.
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const cut = (s: string, n: number) => [...s.replace(UNSTORABLE, "")].slice(0, n).join("");
const fullName = (u: SwUser | undefined, id: number) =>
  cut(personName(u) || `Splitwise user ${id}`, MAX_GROUP);

/** Group id → the name shown in Alopex: Splitwise's own, made unique and short enough. Among
 *  same-named groups the oldest (lowest id) keeps the plain name, whatever order the API lists
 *  them in (H231). */
export function groupLabels(groups: SwGroup[]): Map<number, string> {
  const out = new Map<number, string>();
  const used = new Set<string>();
  for (const g of [...groups].sort((a, b) => a.id - b.id)) {
    let name = g.id === 0 ? NON_GROUP : cut((g.name ?? "").trim(), MAX_GROUP) || `Splitwise group ${g.id}`;
    if (used.has(name)) name = `${cut(name, MAX_GROUP - ` (${g.id})`.length)} (${g.id})`;
    used.add(name);
    out.set(g.id, name);
  }
  return out;
}

const groupName = (labels: Map<number, string>, id: number | null | undefined) =>
  !id ? (labels.get(0) ?? NON_GROUP) : (labels.get(id) ?? `Splitwise group ${id}`);

const CURRENCY = /^[A-Z]{3}$/;
// An unreadable or out-of-range balance is left out rather than failing the whole sync.
const safeCents = (value: string) => {
  try {
    return cents(value);
  } catch {
    return null;
  }
};

function cents(value: string): number {
  const c = toCents(value);
  if (Math.abs(c) >= MAX_CENTS) throw new RangeError("amount out of range");
  return c;
}

/** One expense, seen from user `me`. */
export function classify(e: SwExpense, me: number, labels: Map<number, string>): Classified {
  if (e.deleted_at) return { type: "gone", id: e.id };
  const mine = (e.users ?? []).find((u) => u.user_id === me);
  if (!mine) return { type: "gone", id: e.id };
  let paid: number, owed: number, cost: number, otherPayers: number;
  try {
    paid = cents(mine.paid_share);
    owed = cents(mine.owed_share);
    cost = cents(e.cost ?? "");
    otherPayers = (e.users ?? []).filter((u) => u.user_id !== me && cents(u.paid_share) > 0).length;
  } catch {
    return { type: "skip", id: e.id };
  }
  const currency = e.currency_code ?? "";
  // shortcut: the UTC calendar day of Splitwise's timestamp. Alopex stores no time zone per user,
  // so an expense entered near midnight far from UTC can land a day (or a month) off. Adopting a
  // CSV row allows ±1 day, so it is not doubled. Use the user's zone once Alopex has one.
  const date = (e.date ?? "").slice(0, 10);
  if (!CURRENCY.test(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || paid < 0 || owed < 0) return { type: "skip", id: e.id };

  const base = {
    splitwise_id: e.id,
    group_name: groupName(labels, e.group_id),
    booking_date: date,
    description: cut((e.description ?? "").trim(), MAX_DESCRIPTION),
    currency,
    splitwise_updated_at: e.updated_at ?? null,
  };
  const review = (kind: ReviewKind, share: number): Classified => ({
    type: "review",
    row: { ...base, kind, cost: centsToDecimal(cost), my_share: centsToDecimal(share), my_paid: centsToDecimal(paid) },
  });
  if (e.payment) {
    // The other side of the payment: who received it when I paid, who paid it when I received.
    const positive = (v: string) => {
      try {
        return cents(v) > 0;
      } catch {
        return false; // an unreadable share names no one
      }
    };
    const other = (e.users ?? []).find((u) => u.user_id !== me && positive(paid > 0 ? u.owed_share : u.paid_share));
    const name = personName(other?.user);
    const settle = (kind: ReviewKind, share: number): Classified => {
      const c = review(kind, share);
      if (c.type === "review") c.row.counterparty = name ? cut(name, MAX_NAME) : null;
      return c;
    };
    if (paid > 0) return settle("settle_out", paid);
    if (owed > 0) return settle("settle_in", owed);
    return { type: "gone", id: e.id };
  }
  if (paid > 0) return review(otherPayers > 0 ? "multi_payer" : "paid_by_me", owed);
  if (owed > 0) return { type: "share", row: { ...base, category: categoryFrom(e.category?.name), amount: centsToDecimal(owed) } };
  return { type: "gone", id: e.id };
}

export type SyncPlan = {
  shares: ShareRow[];
  review: ReviewRow[];
  gone: number[];
  skipped: number[];
  /** Every expense id read (for the weekly full check). */
  seen: number[];
  /** The newest updated_at read, or null when nothing was read. */
  cursor: string | null;
};

export function planSync(expenses: SwExpense[], me: number, labels: Map<number, string>): SyncPlan {
  const plan: SyncPlan = { shares: [], review: [], gone: [], skipped: [], seen: [], cursor: null };
  let newest = -Infinity;
  const done = new Set<number>();
  for (const e of expenses) {
    const t = Date.parse(e.updated_at ?? "");
    if (t > newest) newest = t;
    if (done.has(e.id)) continue; // offset paging over a moving list can repeat a row
    done.add(e.id);
    plan.seen.push(e.id);
    const c = classify(e, me, labels);
    if (c.type === "share") plan.shares.push(c.row);
    else if (c.type === "review") plan.review.push(c.row);
    else if (c.type === "gone") plan.gone.push(c.id);
    else plan.skipped.push(c.id);
  }
  plan.cursor = Number.isFinite(newest) ? new Date(newest).toISOString() : null;
  return plan;
}

/**
 * Balances as Splitwise reports them, per group and currency: my row is what the group owes me
 * (my member balance); everyone else's is what I owe them (negative: they owe me), summed from
 * the group's debts before Splitwise simplifies them. Groups I'm not in, and zeros, are left out.
 */
export function balancesFrom(groups: SwGroup[], me: number, labels: Map<number, string>): BalanceRow[] {
  const out: BalanceRow[] = [];
  for (const g of groups) {
    const members = g.members ?? [];
    const self = members.find((m) => m.id === me);
    if (!self) continue;
    const group_name = groupName(labels, g.id);
    const names = new Map(members.map((m) => [m.id, fullName(m, m.id)]));
    const person = (id: number) => {
      const name = names.get(id) ?? fullName(undefined, id);
      const clash = [...names].some(([other, n]) => other !== id && n === name);
      return clash ? `${cut(name, MAX_GROUP - ` (${id})`.length)} (${id})` : name;
    };
    for (const b of self.balance ?? []) {
      const c = safeCents(b.amount);
      if (c && CURRENCY.test(b.currency_code)) out.push({ group_name, person: person(me), balance: centsToDecimal(c), currency: b.currency_code, is_me: true });
    }
    const owe = new Map<string, { id: number; currency: string; cents: number }>();
    for (const d of g.original_debts ?? []) {
      const amount = safeCents(d.amount);
      if ((d.from !== me && d.to !== me) || !amount || !CURRENCY.test(d.currency_code)) continue;
      const other = d.from === me ? d.to : d.from;
      const key = `${other}|${d.currency_code}`;
      const entry = owe.get(key) ?? { id: other, currency: d.currency_code, cents: 0 };
      entry.cents += (d.from === me ? 1 : -1) * amount;
      owe.set(key, entry);
    }
    for (const { id, currency, cents } of owe.values()) {
      if (cents !== 0) out.push({ group_name, person: person(id), balance: centsToDecimal(cents), currency, is_me: false });
    }
  }
  return out;
}
