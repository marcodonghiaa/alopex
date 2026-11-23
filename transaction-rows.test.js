const test = require('node:test');
const assert = require('node:assert');
const { buildRows } = require('./transaction-rows');

const tx = (over = {}) => ({
  entry_reference: 'r1',
  transaction_amount: { amount: '12.50', currency: 'EUR' },
  credit_debit_indicator: 'DBIT',
  booking_date: '2026-10-01',
  remittance_information: ['coffee'],
  ...over,
});

test('keeps bank-provided entry_reference', () => {
  const [row] = buildRows([tx()], 'acc', 'user');
  assert.strictEqual(row.entry_reference, 'r1');
  assert.strictEqual(row.amount, 12.5);
});

test('derives a stable non-null reference when the bank omits it', () => {
  const a = buildRows([tx({ entry_reference: null })], 'acc', 'user')[0].entry_reference;
  const b = buildRows([tx({ entry_reference: undefined })], 'acc', 'user')[0].entry_reference;
  assert.match(a, /^h:[0-9a-f]{24}$/);
  assert.strictEqual(a, b);
});

test('identical reference-less twins stay distinct', () => {
  const rows = buildRows([tx({ entry_reference: null }), tx({ entry_reference: null })], 'acc', 'user');
  assert.strictEqual(rows.length, 2);
  assert.notStrictEqual(rows[0].entry_reference, rows[1].entry_reference);
});

test('duplicate entry_reference in one batch collapses to one row', () => {
  const rows = buildRows([tx(), tx({ remittance_information: ['later'] })], 'acc', 'user');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].remittance_info, 'later');
});

// protects=income shows who paid you, not your own name; fails_when=a credit keeps the account
// holder as creditor_name, or a debit stops using the creditor
test('names a credit after the payer and a debit after the payee', () => {
  const credit = buildRows([tx({
    credit_debit_indicator: 'CRDT', creditor: { name: 'Me' }, debtor: { name: 'GameBoost' },
  })], 'acc', 'user')[0];
  assert.strictEqual(credit.creditor_name, 'GameBoost');
  assert.strictEqual(credit.debtor_name, 'GameBoost');
  const debit = buildRows([tx({ creditor: { name: 'Spotify' }, debtor: { name: 'Me' } })], 'acc', 'user')[0];
  assert.strictEqual(debit.creditor_name, 'Spotify');
});

test('a credit without a payer name keeps whatever name the bank gave', () => {
  const [row] = buildRows([tx({ credit_debit_indicator: 'CRDT', creditor: { name: 'Me' } })], 'acc', 'user');
  assert.strictEqual(row.creditor_name, 'Me');
});

// Regression: a pending transaction and its booked copy got different ids and both were kept,
// so the spend counted twice.
test('pending transactions are left out until the bank books them', () => {
  const rows = buildRows(
    [tx({ entry_reference: null, status: 'PDNG', booking_date: null }), tx({ entry_reference: 'b1', status: 'BOOK' }), tx({ entry_reference: 'b2' })],
    'acc',
    'u1',
  );
  assert.deepStrictEqual(rows.map((r) => r.entry_reference), ['b1', 'b2']);
});

test('raw drops the counterparty account numbers, keeps the rest', () => {
  const [row] = buildRows([tx({
    creditor_account: { iban: 'DE89370400440532013000' },
    debtor_account: { iban: 'IT60X0542811101000000123456' },
    creditor: { name: 'Shop' },
  })], 'acc', 'user');
  assert.equal('creditor_account' in row.raw, false);
  assert.equal('debtor_account' in row.raw, false);
  assert.deepEqual(row.raw.creditor, { name: 'Shop' });
});

test('own_counterparty: only set when your own IBANs are known', () => {
  const debit = tx({ creditor_account: { iban: 'DE89 3704 0044 0532 0130 00' } });
  const own = new Set(['DE89370400440532013000']);
  assert.strictEqual(buildRows([debit], 'acc', 'user', own)[0].own_counterparty, true);
  assert.strictEqual(buildRows([debit], 'acc', 'user', new Set())[0].own_counterparty, false);
  assert.equal('own_counterparty' in buildRows([debit], 'acc', 'user')[0], false);
  const credit = tx({ credit_debit_indicator: 'CRDT', creditor_account: { iban: 'DE89370400440532013000' } });
  assert.strictEqual(buildRows([credit], 'acc', 'user', own)[0].own_counterparty, null); // payer IBAN missing
  const fromOwn = tx({ credit_debit_indicator: 'CRDT', debtor_account: { iban: 'de89370400440532013000' } });
  assert.strictEqual(buildRows([fromOwn], 'acc', 'user', own)[0].own_counterparty, true); // credit reads the payer
});

// H014/H016: some banks reuse one entry_reference. Both transactions are kept, each once, with
// keys that never change across syncs (the same keys as the Deno port).
const { lookupKeys, storedContent } = require('./transaction-rows');
function syncInto(table, batch, dateFrom = null) {
  const stored = new Map();
  for (const key of lookupKeys(batch)) if (table.has(key)) stored.set(key, storedContent(table.get(key).raw));
  for (const row of buildRows(batch, 'acc', 'user', undefined, stored, dateFrom)) table.set(row.entry_reference, row);
}
const amounts = (table) => [...table.values()].map((r) => r.amount).sort();

test('a reused entry_reference keeps both transactions, each once, across syncs', () => {
  const a = tx({ booking_date: '2026-09-01', transaction_amount: { amount: '10.00', currency: 'EUR' } });
  const b = tx({ booking_date: '2026-11-10', transaction_amount: { amount: '40.00', currency: 'EUR' } });
  for (const syncs of [[[a, b], [b], [b, a]], [[b, a], [a], [a, b]], [[a], [b], [a, b], [b]]]) {
    const table = new Map();
    for (const batch of syncs) syncInto(table, batch);
    assert.deepStrictEqual(amounts(table), [10, 40], JSON.stringify([...table.keys()]));
  }
});

test('a stored bare reference keeps its key; a later reuse gets its own stable key', () => {
  const a = tx({ booking_date: '2026-09-01', transaction_amount: { amount: '10.00', currency: 'EUR' } });
  const b = tx({ booking_date: '2026-11-10', transaction_amount: { amount: '40.00', currency: 'EUR' } });
  const table = new Map();
  syncInto(table, [a]);
  syncInto(table, [b]);
  syncInto(table, [b]);
  assert.strictEqual(table.get('r1').amount, 10);
  assert.deepStrictEqual([...table.keys()], ['r1', 'r1#c217b97efb0f']);
});

test('the bank changing a stored row updates it, not a second row', () => {
  const table = new Map();
  syncInto(table, [tx({ transaction_amount: { amount: '10.00', currency: 'EUR' } })]);
  syncInto(table, [tx({ transaction_amount: { amount: '12.00', currency: 'EUR' } })]);
  assert.deepStrictEqual([...table.entries()].map(([k, r]) => [k, r.amount]), [['r1', 12]]);
});

test('a stored row with no bank payload keeps the bare reference', () => {
  const rows = buildRows([tx({ booking_date: '2026-11-10' })], 'acc', 'user', undefined, new Map([['r1', storedContent(null)]]));
  assert.deepStrictEqual(rows.map((r) => r.entry_reference), ['r1']);
});

// Review of H014: "older than the window" is the window the sync asked for (date_from), not the
// oldest row the bank happened to send. A row the bank moved forward inside the window is updated.
test('a stored row whose date the bank moved forward inside the window is updated, not stored twice', () => {
  const table = new Map();
  syncInto(table, [tx({ booking_date: '2026-11-14', transaction_amount: { amount: '10.00', currency: 'EUR' } })]);
  syncInto(table, [
    tx({ booking_date: '2026-11-15', transaction_amount: { amount: '10.00', currency: 'EUR' } }),
    tx({ booking_date: '2026-11-20', transaction_amount: { amount: '40.00', currency: 'EUR' } }),
  ], '2026-11-13');
  assert.deepStrictEqual(amounts(table), [10, 40]);
  assert.strictEqual(table.get('r1').booking_date, '2026-11-15');
});

test('a reuse whose stored row is older than the window still gets its own key', () => {
  const table = new Map();
  syncInto(table, [tx({ booking_date: '2026-09-01', transaction_amount: { amount: '10.00', currency: 'EUR' } })]);
  syncInto(table, [tx({ booking_date: '2026-11-20', transaction_amount: { amount: '40.00', currency: 'EUR' } })], '2026-11-13');
  assert.deepStrictEqual(amounts(table), [10, 40]);
  assert.strictEqual(table.get('r1').amount, 10);
});
