import { assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1.0.19";
import { buildRows, type EbTransaction, lookupKeys, normalizeIban, ownCounterparty, storedContent } from "./transaction-rows.ts";

const tx = (over: EbTransaction = {}): EbTransaction => ({
  entry_reference: "r1",
  transaction_amount: { amount: "12.50", currency: "EUR" },
  credit_debit_indicator: "DBIT",
  booking_date: "2026-10-01",
  remittance_information: ["coffee"],
  ...over,
});

Deno.test("keeps bank-provided entry_reference", async () => {
  const [row] = await buildRows([tx()], "acc", "user");
  assertEquals(row.entry_reference, "r1");
  assertEquals(row.amount, 12.5);
});

// protects=rows already stored (some by the old Node sync); fails_when=the derived hash changes,
// which would insert every reference-less transaction a second time.
Deno.test("derived references match the Node sync byte for byte", async () => {
  const rows = await buildRows([tx({ entry_reference: null }), tx({ entry_reference: null })], "acc", "user");
  assertEquals(rows.map((r) => r.entry_reference), ["h:6b5383949650b9219eb070a6", "h:6907b02f0bcbc0227ec20c7f"]);
});

Deno.test("derives a stable non-null reference when the bank omits it", async () => {
  const [a] = await buildRows([tx({ entry_reference: null })], "acc", "user");
  const [b] = await buildRows([tx({ entry_reference: undefined })], "acc", "user");
  assertMatch(a.entry_reference as string, /^h:[0-9a-f]{24}$/);
  assertEquals(a.entry_reference, b.entry_reference);
});

Deno.test("identical reference-less twins stay distinct", async () => {
  const rows = await buildRows([tx({ entry_reference: null }), tx({ entry_reference: null })], "acc", "user");
  assertEquals(rows.length, 2);
  assertNotEquals(rows[0].entry_reference, rows[1].entry_reference);
});

Deno.test("duplicate entry_reference in one batch collapses to one row", async () => {
  const rows = await buildRows([tx(), tx({ remittance_information: ["later"] })], "acc", "user");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].remittance_info, "later");
});

Deno.test("names a credit after the payer and a debit after the payee", async () => {
  const [credit] = await buildRows([tx({
    credit_debit_indicator: "CRDT", creditor: { name: "Me" }, debtor: { name: "GameBoost" },
  })], "acc", "user");
  assertEquals(credit.creditor_name, "GameBoost");
  const [debit] = await buildRows([tx({ creditor: { name: "Spotify" }, debtor: { name: "Me" } })], "acc", "user");
  assertEquals(debit.creditor_name, "Spotify");
});

Deno.test("pending transactions are left out until the bank books them", async () => {
  const rows = await buildRows(
    [tx({ entry_reference: null, status: "PDNG", booking_date: null }), tx({ entry_reference: "b1", status: "BOOK" })],
    "acc",
    "u1",
  );
  assertEquals(rows.map((r) => (r as { entry_reference: string }).entry_reference), ["b1"]);
});

Deno.test("merchant_key is the normalized creditor_name the row shows", async () => {
  const [out] = await buildRows([tx({ creditor: { name: "LIDL 4521 MILANO IT" } })], "acc", "user");
  assertEquals(out.merchant_key, "lidl");
  const [inc] = await buildRows(
    [tx({ credit_debit_indicator: "CRDT", debtor: { name: "Mario Rossi" } })], "acc", "user");
  assertEquals(inc.merchant_key, "mario rossi");
  const [none] = await buildRows([tx()], "acc", "user");
  assertEquals(none.merchant_key, null);
});

// protects=counterparties' IBANs; fails_when=raw keeps creditor_account or debtor_account.
Deno.test("raw drops the counterparty account numbers, keeps the rest", async () => {
  const [row] = await buildRows([tx({
    creditor_account: { iban: "DE89370400440532013000" },
    debtor_account: { iban: "IT60X0542811101000000123456" },
    creditor: { name: "Shop" },
  })], "acc", "user");
  const raw = row.raw as EbTransaction;
  assertEquals("creditor_account" in raw, false);
  assertEquals("debtor_account" in raw, false);
  assertEquals(raw.creditor, { name: "Shop" });
  assertEquals(raw.entry_reference, "r1");
});

Deno.test("own_counterparty: normalised IBAN match, other account false, no IBAN null", () => {
  const own = new Set([normalizeIban("IT60 X054 2811 1010 0000 0123 456")]);
  assertEquals(ownCounterparty(tx({ creditor_account: { iban: "it60x0542811101000000123456" } }), own), true);
  assertEquals(ownCounterparty(tx({ creditor_account: { iban: "DE89370400440532013000" } }), own), false);
  assertEquals(ownCounterparty(tx({ creditor_account: {} }), own), null);
  assertEquals(ownCounterparty(tx(), own), null);
  // A credit's counterparty is the debtor; the creditor is you.
  const credit = { credit_debit_indicator: "CRDT", creditor_account: { iban: "IT60X0542811101000000123456" } };
  assertEquals(ownCounterparty(tx({ ...credit, debtor_account: { iban: "DE89 3704 0044 0532 0130 00" } }), own), false);
  assertEquals(ownCounterparty(tx({ ...credit, debtor_account: { iban: "IT60X0542811101000000123456" } }), own), true);
  assertEquals(ownCounterparty(tx({ creditor_account: { iban: "IT60X0542811101000000123456" } })), null); // own IBANs unknown
});

Deno.test("buildRows keeps own_counterparty but not the IBAN", async () => {
  const [row] = await buildRows([tx({ creditor_account: { iban: "IT60X0542811101000000123456" } })], "acc", "user", new Set(["IT60X0542811101000000123456"]));
  assertEquals(row.own_counterparty, true);
  assertEquals("creditor_account" in (row.raw as object), false);
});

// protects=a sync re-run keeps the user's note and tags: the upsert only sets the columns its rows
// carry (the Edge Function sync runs this builder); fails_when=a row starts carrying note or tags
Deno.test("rows never carry note or tags", async () => {
  for (const own of [undefined, new Set<string>()]) {
    const [row] = await buildRows([tx()], "acc", "user", own);
    assertEquals("note" in row, false);
    assertEquals("tags" in row, false);
  }
});

// The table, keyed on (account, entry_reference). Each sync reads the stored rows its keys may
// meet (lookupKeys), as bank-sync does, then upserts.
type Row = Record<string, unknown>;
async function syncInto(table: Map<unknown, Row>, batch: EbTransaction[], dateFrom: string | null = null) {
  const stored = new Map<string, string | null>();
  for (const key of await lookupKeys(batch)) if (table.has(key)) stored.set(key, storedContent(table.get(key)!.raw));
  for (const row of await buildRows(batch, "acc", "user", undefined, stored, dateFrom)) table.set(row.entry_reference, row);
}
const amounts = (table: Map<unknown, Row>) => [...table.values()].map((r) => r.amount).sort();

// Polish 1 #1, H014/H016. Some banks reuse one entry_reference (Enable Banking FAQ). Both
// transactions must be kept, and whatever key each gets must not depend on what else is in the
// batch: the first sync sees old A and new B, the next cron sync (cursor minus 7 days) only B.
Deno.test("a reused entry_reference keeps both transactions, each once, across syncs", async () => {
  const a = tx({ booking_date: "2026-09-01", transaction_amount: { amount: "10.00", currency: "EUR" } });
  const b = tx({ booking_date: "2026-11-10", transaction_amount: { amount: "40.00", currency: "EUR" } });
  for (const syncs of [[[a, b], [b], [b, a]], [[b, a], [a], [a, b]], [[a], [b], [a, b], [b]]]) {
    const table = new Map<unknown, Row>();
    for (const batch of syncs) await syncInto(table, batch);
    assertEquals(amounts(table), [10, 40], JSON.stringify([...table.keys()]));
  }
});

// The key a row was stored under never changes, so nothing stored before this fix is duplicated.
Deno.test("a stored bare reference keeps its key; a later reuse gets its own stable key", async () => {
  const a = tx({ booking_date: "2026-09-01", transaction_amount: { amount: "10.00", currency: "EUR" } });
  const b = tx({ booking_date: "2026-11-10", transaction_amount: { amount: "40.00", currency: "EUR" } });
  const table = new Map<unknown, Row>();
  await syncInto(table, [a]);
  await syncInto(table, [b]);
  await syncInto(table, [b]);
  assertEquals(table.get("r1")?.amount, 10);
  assertEquals([...table.keys()], ["r1", "r1#c217b97efb0f"]);
});

// The bank correcting a row it already sent (same reference, new amount, still in the window)
// updates that row, as before, instead of adding a second one.
Deno.test("the bank changing a stored row updates it, not a second row", async () => {
  const table = new Map<unknown, Row>();
  await syncInto(table, [tx({ transaction_amount: { amount: "10.00", currency: "EUR" } })]);
  await syncInto(table, [tx({ transaction_amount: { amount: "12.00", currency: "EUR" } })]);
  assertEquals([...table.entries()].map(([k, r]) => [k, r.amount]), [["r1", 12]]);
});

// A stored row without the bank payload (raw) can't be compared: it keeps the bare key, as before.
Deno.test("a stored row with no bank payload keeps the bare reference", async () => {
  const rows = await buildRows([tx({ booking_date: "2026-11-10" })], "acc", "user", undefined, new Map([["r1", storedContent(null)]]));
  assertEquals(rows.map((r) => r.entry_reference), ["r1"]);
});

// Review of H014: "older than the window" is the window the sync asked for (date_from), not the
// oldest row the bank happened to send. A row the bank moved forward inside the window is updated.
Deno.test("a stored row whose date the bank moved forward inside the window is updated, not stored twice", async () => {
  const table = new Map<unknown, Row>();
  await syncInto(table, [tx({ booking_date: "2026-11-14", transaction_amount: { amount: "10.00", currency: "EUR" } })]);
  await syncInto(table, [
    tx({ booking_date: "2026-11-15", transaction_amount: { amount: "10.00", currency: "EUR" } }),
    tx({ booking_date: "2026-11-20", transaction_amount: { amount: "40.00", currency: "EUR" } }),
  ], "2026-11-13");
  assertEquals(amounts(table), [10, 40]);
  assertEquals(table.get("r1")?.booking_date, "2026-11-15");
});

Deno.test("a reuse whose stored row is older than the window still gets its own key", async () => {
  const table = new Map<unknown, Row>();
  await syncInto(table, [tx({ booking_date: "2026-09-01", transaction_amount: { amount: "10.00", currency: "EUR" } })]);
  await syncInto(table, [tx({ booking_date: "2026-11-20", transaction_amount: { amount: "40.00", currency: "EUR" } })], "2026-11-13");
  assertEquals(amounts(table), [10, 40]);
  assertEquals(table.get("r1")?.amount, 10);
});

// H040: a row with no booking_date fell out of every monthly view and FX join.
Deno.test("a missing booking_date falls back to the value date, then the transaction date", async () => {
  const [a] = await buildRows([tx({ booking_date: null, value_date: "2026-10-02" })], "acc", "user");
  const [b] = await buildRows([tx({ booking_date: null, transaction_date: "2026-10-03" })], "acc", "user");
  const [c] = await buildRows([tx({ booking_date: "2026-10-01", value_date: "2026-10-05" })], "acc", "user");
  assertEquals([a.booking_date, b.booking_date, c.booking_date], ["2026-10-02", "2026-10-03", "2026-10-01"]);
});
Deno.test("the fallback date leaves the derived reference unchanged", async () => {
  const [row] = await buildRows([tx({ entry_reference: null, booking_date: null, value_date: "2026-10-02" })], "acc", "user");
  const [same] = await buildRows([tx({ entry_reference: null, booking_date: undefined, value_date: "2026-10-02" })], "acc", "user");
  assertEquals(row.entry_reference, same.entry_reference);
});
