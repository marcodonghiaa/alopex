// 20270124000000_pending_transactions: transactions gain pending (false by default), the dashboard's
// v_transactions_eur shows it, and the rollback deletes the pending rows and drops the column.
// Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270124000000_pending_transactions';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const row = (user, acc, ref, extra = '') => `insert into public.transactions
  (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date${extra ? ', pending' : ''})
  values ('${ref}', '${acc}', '${user}', 12.29, 'EUR', 'DBIT', '2026-11-27'${extra})`;

test('pending transactions', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('pending_transactions', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.accounts (uid, user_id, currency) values ('a0000000-0000-0000-0000-00000000000a', '${A}', 'EUR'), ('b0000000-0000-0000-0000-00000000000b', '${B}', 'EUR');
    ${row(A, 'a0000000-0000-0000-0000-00000000000a', 'booked-before')}`);
  applySql(`supabase/migrations/${NAME}.sql`);
  applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run
  admin(`${row(A, 'a0000000-0000-0000-0000-00000000000a', 'p:abc', ', true')}; ${row(B, 'b0000000-0000-0000-0000-00000000000b', 'p:theirs', ', true')}`);

  await t.test('rows stored before are not pending', () => {
    assert.strictEqual(admin(`select pending from public.transactions where entry_reference = 'booked-before'`), 'f');
  });

  await t.test('the view shows pending, and only the user\'s own rows', () => {
    assert.strictEqual(as(A, `select string_agg(entry_reference || '=' || pending, ',' order by entry_reference) from public.v_transactions_eur`),
      'booked-before=false,p:abc=true');
  });

  await t.test('the rollback deletes pending rows and the column; the view still runs', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(admin(`select string_agg(entry_reference, ',') from public.transactions`), 'booked-before');
    assert.strictEqual(admin(`select count(*) from information_schema.columns where table_name = 'transactions' and column_name = 'pending'`), '0');
    assert.strictEqual(as(A, `select string_agg(entry_reference || '=' || pending, ',') from public.v_transactions_eur`), 'booked-before=false');
  });
});
