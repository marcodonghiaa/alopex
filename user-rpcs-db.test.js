// H094: the user-callable security definer RPCs that write money rows, on a real Postgres with every
// migration (so the live definitions, not superseded ones). Table-driven: each RPC called by user B
// on user A's ids fails or does nothing and leaves A's rows as they were; then each works for A.
// register_dashboard_origin and holding_performance have their own DB tests.
// Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACC = 'aaaaaaaa-1111-0000-0000-000000000001';
const SAV = 'aaaaaaaa-1111-0000-0000-000000000002';
const DEBT = 'aaaaaaaa-2222-0000-0000-000000000001';
const PAIR = 'aaaaaaaa-3333-0000-0000-000000000001';
const STREAM = 'aaaaaaaa-4444-0000-0000-000000000001';
const ISIN = 'US0000000001';

// Everything A owns, as one text, to prove a call by B changed nothing.
const FINGERPRINT = `select md5(string_agg(x, '|' order by x)) from (
  select row(a.*)::text x from public.accounts a where user_id = '${A}'
  union all select row(s.*)::text from public.net_worth_snapshots s where user_id = '${A}'
  union all select row(t.*)::text from public.transactions t where user_id = '${A}'
  union all select row(p.*)::text from public.transfer_pairs p where user_id = '${A}'
  union all select row(r.*)::text from public.recurring_streams r where user_id = '${A}'
  union all select row(h.*)::text from public.portfolio_holdings h where user_id = '${A}'
  union all select row(c.*)::text from public.crypto_holdings c where user_id = '${A}') q`;

// [call, what B gets back]: an error naming the miss, or a count of 0 rows touched.
const CROSS_USER = [
  [`select public.set_manual_balance('${DEBT}', 1)`, /account not found/],
  [`select public.set_account_type('${ACC}', 'loan')`, /account not found/],
  [`select public.delete_manual_debt('${DEBT}')`, /account not found/],
  [`select public.resolve_transfer_pair('${PAIR}', true)`, /Transfer pair not found/],
  [`select public.stream_action('${STREAM}', 'confirm')`, /Stream not found/],
  [`select public.set_holding_quantity('stock', '${ISIN}', 99)`, /^0$/],
  [`select public.delete_holding('stock', '${ISIN}')`, /^0$/],
  [`select public.delete_holding('crypto', 'BTC', 'Ledger')`, /^0$/],
  // These create rows, but only the caller's.
  [`select count(*) from public.add_manual_transaction('2026-11-01', 'Coffee', 3, 'DBIT')`, /^1$/],
  [`select public.add_manual_debt('Car', 1000) is not null`, /^t$/],
];

test('user RPCs act for the caller only', { skip }, async (t) => {
  const { admin, as, drop } = fullChainDb('user_rpcs');
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.accounts (uid, user_id, currency, label) values ('${ACC}', '${A}', 'EUR', 'Main'), ('${SAV}', '${A}', 'EUR', 'Savings');
    insert into public.accounts (uid, user_id, currency, label, manual, account_type) values ('${DEBT}', '${A}', 'EUR', 'Loan', true, 'loan');
    insert into public.net_worth_snapshots (account_uid, user_id, currency, amount, snapshot_date) values ('${DEBT}', '${A}', 'EUR', -500, current_date - 1);
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, flow_type, flow_source) values
      ('out', '${ACC}', '${A}', 100, 'EUR', 'DBIT', '2026-11-01', 'transfer', 'pair'),
      ('in', '${SAV}', '${A}', 100, 'EUR', 'CRDT', '2026-11-01', 'transfer', 'pair');
    insert into public.transfer_pairs (id, user_id, out_account_uid, out_ref, in_account_uid, in_ref) values ('${PAIR}', '${A}', '${ACC}', 'out', '${SAV}', 'in');
    insert into public.recurring_streams (id, user_id, stream_key, merchant_key, currency, detected_status) values ('${STREAM}', '${A}', 'gym', 'gym', 'EUR', 'suggested');
    insert into public.portfolio_holdings (user_id, isin, yahoo_symbol, name, shares, broker_label, asset_type) values ('${A}', '${ISIN}', 'AAA', 'Acme', 10, 'T', 'Stock');
    insert into public.crypto_holdings (user_id, source, asset_symbol, name, amount, coingecko_id) values ('${A}', 'Ledger', 'BTC', 'Bitcoin', 1, 'bitcoin');`);
  const mine = admin(FINGERPRINT);

  await t.test("B's calls on A's ids fail or touch nothing; A's rows are unchanged", () => {
    for (const [call, expected] of CROSS_USER) {
      assert.match(as(B, call), expected, call);
      assert.strictEqual(admin(FINGERPRINT), mine, `${call} changed A's rows`);
    }
    assert.strictEqual(admin(`select count(*) from public.accounts where user_id = '${B}' and manual`), '2');
    assert.strictEqual(admin(`select count(*) from public.transactions where user_id = '${B}'`), '1');
  });

  await t.test('signed out, every call is refused', () => {
    const anonymous = (q) => admin(`begin; set local role authenticated; set local request.jwt.claims = '{"role":"authenticated"}'; ${q}; rollback;`);
    for (const [call] of CROSS_USER.filter(([c]) => !/resolve_transfer_pair|stream_action/.test(c))) {
      assert.throws(() => anonymous(call), /not signed in/, call);
    }
  });

  await t.test('A: manual debt balance, type, add and delete', () => {
    assert.match(as(A, `select public.set_manual_balance('${DEBT}', 'NaN')`), /out of range/);
    assert.match(as(A, `select public.set_manual_balance('${ACC}', 1)`), /not a manual account/);
    as(A, `select public.set_manual_balance('${DEBT}', -250)`);
    assert.strictEqual(admin(`select amount from public.net_worth_snapshots where account_uid = '${DEBT}' and snapshot_date = current_date`), '-250');
    assert.match(as(A, `select public.set_account_type('${DEBT}', 'savings')`), /manual accounts can only be debts/);
    as(A, `select public.set_account_type('${ACC}', 'savings')`);
    assert.strictEqual(admin(`select account_type from public.accounts where uid = '${ACC}'`), 'savings');
    const car = as(A, `select public.add_manual_debt('Car', 1000)`);
    assert.strictEqual(admin(`select a.user_id || ' ' || a.account_type || ' ' || s.amount from public.accounts a join public.net_worth_snapshots s on s.account_uid = a.uid where a.uid = '${car}'`), `${A} loan 1000`);
    as(A, `select public.delete_manual_debt('${car}')`);
    assert.strictEqual(admin(`select count(*) from public.accounts where uid = '${car}'`), '0');
    assert.match(as(A, `select public.delete_manual_debt('${ACC}')`), /not a manual debt/);
  });

  await t.test('A: a typed-in transaction lands in a manual account of A, never in a debt', () => {
    admin(`update public.accounts set label = 'Manual' where uid = '${DEBT}'`);
    as(A, `select * from public.add_manual_transaction('2026-11-02', 'Lunch', 12, 'DBIT')`);
    assert.strictEqual(admin(`select t.user_id || ' ' || a.manual || ' ' || coalesce(a.account_type, '-') || ' ' || t.amount from public.transactions t join public.accounts a on a.uid = t.account_uid where t.creditor_name = 'Lunch'`), `${A} true - 12`);
    assert.match(as(A, `select * from public.add_manual_transaction('2026-11-02', 'Lunch', -1, 'DBIT')`), /above zero/);
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date) values ('debt-row', '${DEBT}', '${A}', 1, 'EUR', 'DBIT', '2026-11-01')`);
    assert.match(as(A, `select public.delete_manual_debt('${DEBT}')`), /account has transactions/);
  });

  await t.test('A: keep a transfer pair, confirm a stream, set and delete holdings', () => {
    as(A, `select public.resolve_transfer_pair('${PAIR}', true)`);
    assert.strictEqual(admin(`select status from public.transfer_pairs where id = '${PAIR}'`), 'confirmed');
    assert.match(as(A, `select public.resolve_transfer_pair('${PAIR}', false)`), /already confirmed/);
    as(A, `select public.stream_action('${STREAM}', 'confirm')`);
    assert.strictEqual(admin(`select user_status from public.recurring_streams where id = '${STREAM}'`), 'confirmed');
    assert.strictEqual(as(A, `select public.set_holding_quantity('stock', '${ISIN}', 5)`), '1');
    assert.strictEqual(admin(`select shares from public.portfolio_holdings where user_id = '${A}'`), '5');
    assert.strictEqual(as(A, `select public.delete_holding('crypto', 'BTC', 'Ledger')`), '1');
    assert.strictEqual(as(A, `select public.delete_holding('stock', '${ISIN}')`), '1');
    assert.strictEqual(admin(`select count(*) from public.portfolio_holdings where user_id = '${A}'`), '0');
  });
});
