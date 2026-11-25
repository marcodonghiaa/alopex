import { assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import { buildTypePrompt, classifyTypes, isTransferCode } from "./classify-type.ts";
import { memoryDb } from "./memory-db.test-helper.ts";
import type { Ask } from "./gemini.ts";

const tx = (ref: string, creditor: string, over: Record<string, unknown> = {}) => ({
  user_id: "u1", account_uid: "a1", entry_reference: ref, creditor_name: creditor, remittance_info: "",
  amount: 10, currency: "EUR", credit_debit_indicator: "DBIT", bank_transaction_code: "CARD_PAYMENT",
  transaction_type: null, ...over,
});
const seed = () =>
  memoryDb({
    transactions: [
      tx("spotify", "SPOTIFY"),
      tx("rent-split", "Friend", { bank_transaction_code: "V26-Bonifico Istantaneo" }),
      tx("p2p", "Friend", { bank_transaction_code: "TRANSFER" }),
      tx("icloud", "APPLE.COM/BILL"),
      tx("done", "OLD", { transaction_type: "One-time" }),
    ],
    category_rules: [{ user_id: "u1", match_field: "creditor_name", match_text: "spotify", set_transaction_type: "Subscription", priority: 100, created_at: "2026-01-01" }],
  });
const typeOf = (db: ReturnType<typeof memoryDb>, ref: string) => db.tables.transactions.find((r) => r.entry_reference === ref)!.transaction_type;

Deno.test("bank transfer codes are recognized, others are not", () => {
  assertEquals([isTransferCode("TRANSFER"), isTransferCode("V26-Bonifico Istantaneo"), isTransferCode("CARD_PAYMENT"), isTransferCode(null)], [true, true, false, false]);
});

// protects=subscriptions are detected without a Mac, rules and transfers without spending an AI
// call; fails_when=the AI sees a rule or transfer row, or a typed row is touched again
Deno.test("type rules, then transfers as One-time, then the AI for the rest", async () => {
  const db = seed();
  const sent: string[] = [];
  const ask: Ask = async (prompt) => {
    sent.push(...[...prompt.matchAll(/"entry_reference": "([^"]+)"/g)].map((m) => m[1]));
    return [{ entry_reference: "icloud", transaction_type: "Subscription" }];
  };
  const result = await classifyTypes(db, ask);
  assertEquals(sent, ["icloud"]);
  assertEquals(["spotify", "rent-split", "p2p", "icloud", "done"].map((r) => typeOf(db, r)), ["Subscription", "One-time", "One-time", "Subscription", "One-time"]);
  assertEquals(result.typeAiFailed, false);
});

Deno.test("an invalid AI answer is ignored", async () => {
  const db = seed();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await classifyTypes(db, async () => [{ entry_reference: "icloud", transaction_type: "Monthly" }]);
  } finally {
    console.warn = warn;
  }
  assertEquals(typeOf(db, "icloud"), null);
});

Deno.test("without an AI key, or when it fails, rules and transfers still apply", async () => {
  const db = seed();
  assertEquals((await classifyTypes(db, null)).typedByRules, 3);
  assertEquals(typeOf(db, "icloud"), null);
  const failing = seed();
  const err = console.error;
  console.error = () => {};
  try {
    const result = await classifyTypes(failing, async () => {
      throw Object.assign(new Error("x"), { status: 500 });
    });
    assertEquals([result.typeAiFailed, typeOf(failing, "spotify"), typeOf(failing, "p2p")], [true, "Subscription", "One-time"]);
  } finally {
    console.error = err;
  }
});

Deno.test("the type prompt marks the fields as untrusted and allows only the two types", () => {
  const prompt = buildTypePrompt([tx("r", "X")]);
  assertMatch(prompt, /untrusted data from third parties/);
  assertMatch(prompt, /"Subscription" or "One-time"/);
});

// H074: same fix for the Subscription / One-time answers.
Deno.test("the same reference on two accounts: each row gets its own type", async () => {
  const db = memoryDb({
    transactions: [tx("r1", "NETFLIX", { account_uid: "a1" }), tx("r1", "SHOP", { account_uid: "a2" })],
    category_rules: [],
  });
  const ask: Ask = async (prompt) =>
    [...prompt.matchAll(/"entry_reference": "([^"]+)",\s*"creditor_name": "([^"]+)"/g)]
      .map((m) => ({ entry_reference: m[1], transaction_type: m[2] === "NETFLIX" ? "Subscription" : "One-time" }));
  await classifyTypes(db, ask);
  assertEquals(db.tables.transactions.map((r) => [r.account_uid, r.transaction_type]), [["a1", "Subscription"], ["a2", "One-time"]]);
});

Deno.test("an AI that answers nothing stops once the same batch comes back: that user is skipped", async () => {
  const db = memoryDb({ transactions: [tx("a", "SHOP A"), tx("b", "SHOP B", { user_id: "u2" })], category_rules: [] });
  const asked: string[] = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    const result = await classifyTypes(db, async (prompt) => (asked.push(prompt.includes('"a"') ? "a" : "b"), []));
    assertEquals(asked, ["a", "b"]);
    assertEquals(result, { typed: 0, typedByRules: 0, typeAiFailed: false }); // H252: nothing filled
  } finally {
    console.warn = warn;
  }
});
