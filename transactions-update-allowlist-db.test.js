// H085: restrict_transaction_updates is an allowlist (20270110000000_transactions_update_allowlist):
// a signed-in user may change only the columns the app lets them edit, so a column added later is
// server-only until someone allows it. Same rules as before for every column that exists today.
// Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270110000000_transactions_update_allowlist';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const BANK = 'aaaaaaaa-1111-0000-0000-000000000001';
const MAN = 'aaaaaaaa-2222-0000-0000-000000000001';

// What the dashboard and user-callable functions write. Keep in step with the trigger.
const USER_EDITABLE = {
  category: "'Groceries'", category_source: "'manual'", transaction_type: "'One-time'", transaction_type_source: "'manual'",
  worth_it: "'yes'", worth_it_prompted_at: 'now()', personal_amount: '1', owed_by: "'Giulia'", owed_settled: 'true',
  settled_at: 'now()', flow_type: "'income'", flow_source: "'user'", deleted_at: 'now()', import_batch_id: 'gen_random_uuid()',
  custom_name: "'Mine'", note: "'n'", tags: "'{t}'", payback_contact: "'Giulia'", settled_by_account: `'${BANK}'`, settled_by_ref: "'x'",
};
// Editable only on a manual account's rows.
const MANUAL_ONLY = {
  amount: '9', currency: "'USD'", credit_debit_indicator: "'CRDT'", creditor_name: "'Shop'", booking_date: "'2026-01-02'", value_date: "'2026-01-02'",
};
// Never editable by the user (merchant_key may only be cleared).
const SERVER_ONLY = {
  entry_reference: "'zz'", account_uid: 'gen_random_uuid()', user_id: 'gen_random_uuid()', created_at: "'2020-01-01'", raw: "'{}'",
  debtor_name: "'D'", remittance_info: "'R'", bank_transaction_code: "'EXCHANGE'", own_counterparty: 'true', refund_of: "'r'",
  broker_ref: "'b'", broker_label: "'L'", merchant_key: "'mk'",
};

test('transactions update allowlist', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('tx_allowlist', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.accounts (uid, user_id, currency) values ('${BANK}', '${A}', 'EUR');
    insert into public.accounts (uid, user_id, currency, manual) values ('${MAN}', '${A}', 'EUR', true);
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, merchant_key)
      values ('b1', '${BANK}', '${A}', 5, 'EUR', 'DBIT', '2026-01-01', 'shop'), ('m1', '${MAN}', '${A}', 5, 'EUR', 'DBIT', '2026-01-01', null);
    alter table public.transactions add column later_server_col text;`);
  const set = (ref, col, val) => as(A, `update public.transactions set ${col} = ${val} where entry_reference = '${ref}'`);

  await t.test('before: a column added later is writable by the user (the denylist hole)', () => {
    assert.doesNotMatch(set('b1', 'later_server_col', "'forged'"), /ERROR/);
    applySql(`supabase/migrations/${NAME}.sql`);
  });

  await t.test('every column is classified, so a new one has to be decided on', () => {
    const cols = admin(`select string_agg(attname, ',' order by attname) from pg_attribute
      where attrelid = 'public.transactions'::regclass and attnum > 0 and not attisdropped and attname <> 'later_server_col'`);
    assert.strictEqual(cols, Object.keys({ ...USER_EDITABLE, ...MANUAL_ONLY, ...SERVER_ONLY }).sort().join(','));
  });

  await t.test('a column added later is refused for the user', () => {
    assert.match(set('b1', 'later_server_col', "'again'"), /cannot be changed/);
  });

  await t.test('user-editable columns stay writable on bank and manual rows', () => {
    for (const [col, val] of Object.entries(USER_EDITABLE)) {
      for (const ref of ['b1', 'm1']) assert.doesNotMatch(set(ref, col, val), /ERROR/, `${col} on ${ref}`);
    }
  });

  await t.test('bank fields are editable only on a manual account', () => {
    for (const [col, val] of Object.entries(MANUAL_ONLY)) {
      assert.match(set('b1', col, val), /cannot be changed/, col);
      assert.doesNotMatch(set('m1', col, val), /ERROR/, col);
    }
  });

  await t.test('server-only columns are refused; merchant_key may only be cleared', () => {
    for (const [col, val] of Object.entries(SERVER_ONLY)) {
      for (const ref of ['b1', 'm1']) assert.match(set(ref, col, val), /cannot be changed/, `${col} on ${ref}`);
    }
    assert.doesNotMatch(set('b1', 'merchant_key', 'null'), /ERROR/);
  });

  await t.test('the service role (sync, post-sync) is not restricted', () => {
    assert.doesNotMatch(admin(`begin; set local role service_role; set local request.jwt.claims = '{"role":"service_role"}';
      update public.transactions set refund_of = 'm1', later_server_col = 'ok' where entry_reference = 'b1'; commit;`), /ERROR/);
  });

  await t.test('rollback restores the denylist; re-apply works', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.doesNotMatch(set('b1', 'later_server_col', "'forged'"), /ERROR/);
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.match(set('b1', 'later_server_col', "'x'"), /cannot be changed/);
  });
});
