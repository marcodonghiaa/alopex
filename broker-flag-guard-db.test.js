// H254: the bank-field guard, the 'manual' category mark and the 'user' flow mark all stood aside
// whenever the session setting alopex.broker_match was on, and any role that runs SQL can set it.
// 20270119000000_broker_flag_definer_only honours the flag only inside definer code (match_broker_rows,
// move_category), where current_user is the function owner, never for a signed-in session itself.
// Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270119000000_broker_flag_definer_only';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const BANK = 'aaaaaaaa-1111-0000-0000-000000000001';
const FLAG = `select set_config('alopex.broker_match', 'on', true)`;

test('broker flag works only inside definer code', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('broker_flag', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.accounts (uid, user_id, currency) values ('${BANK}', '${A}', 'EUR');
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, category, category_source)
      values ('b1', '${BANK}', '${A}', 5, 'EUR', 'DBIT', '2026-01-01', 'Shopping', 'rule');
    -- Stands in for match_broker_rows: definer code that sets the flag and labels a bank row.
    create function public.test_flagged_label() returns void language plpgsql security definer set search_path = '' as $$
    begin
      perform set_config('alopex.broker_match', 'on', true);
      update public.transactions set broker_label = 'Buy', flow_type = 'transfer', flow_source = 'broker' where entry_reference = 'b1';
      perform set_config('alopex.broker_match', 'off', true);
    end $$;
    grant execute on function public.test_flagged_label() to authenticated;`);
  const amount = () => admin(`select amount from public.transactions where entry_reference = 'b1'`);

  await t.test('before: a session that sets the flag rewrites a bank amount', () => {
    assert.doesNotMatch(as(A, `${FLAG}; update public.transactions set amount = 1 where entry_reference = 'b1'`), /ERROR/);
    assert.strictEqual(amount(), '1');
    admin(`update public.transactions set amount = 5 where entry_reference = 'b1'`);
    applySql(`supabase/migrations/${NAME}.sql`);
    applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run
  });

  await t.test('after: the flag set by the session itself changes nothing', () => {
    assert.match(as(A, `${FLAG}; update public.transactions set amount = 1 where entry_reference = 'b1'`), /Bank-provided fields/);
    assert.strictEqual(amount(), '5');
    as(A, `${FLAG}; update public.transactions set category = 'Groceries', flow_type = 'income', flow_source = 'broker' where entry_reference = 'b1'`);
    assert.strictEqual(admin(`select category_source || '|' || flow_source from public.transactions where entry_reference = 'b1'`), 'manual|user');
  });

  await t.test('definer code that sets the flag still writes for the caller', () => {
    assert.doesNotMatch(as(A, `select public.test_flagged_label()`), /ERROR/);
    assert.strictEqual(admin(`select broker_label || '|' || flow_source from public.transactions where entry_reference = 'b1'`), 'Buy|broker');
  });

  await t.test('move_category still keeps each row\'s category source', () => {
    admin(`update public.transactions set category = 'Shopping', category_source = 'rule' where entry_reference = 'b1'`);
    assert.doesNotMatch(as(A, `select public.move_category('Shopping', 'Groceries')`), /ERROR/);
    assert.strictEqual(admin(`select category || '|' || category_source from public.transactions where entry_reference = 'b1'`), 'Groceries|rule');
  });

  await t.test('the rollback brings back the old triggers', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.doesNotMatch(as(A, `${FLAG}; update public.transactions set amount = 2 where entry_reference = 'b1'`), /ERROR/);
  });
});
