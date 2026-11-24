// H297: undoing a payback lost things the user had: a payer link it replaced was deleted instead of
// put back, and a flow the user had set by hand ("income") was cleared. settled_by_ref, which users
// may write, had no length cap. 20270120000000_payback_undo_restores fixes all three.
// Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270120000000_payback_undo_restores';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACC = 'aaaaaaaa-1111-0000-0000-000000000001';
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

test('payback undo restores what it replaced', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('payback_undo', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC}', '${A}', 'EUR');
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, debtor_name, personal_amount, owed_by, settled_by_ref)
    values ('bill-1', '${ACC}', '${A}', 100, 'EUR', 'DBIT', '${daysAgo(30)}', 'Pizzeria', null, 40, 'Anna', repeat('r', 1001)),
           ('pay-1', '${ACC}', '${A}', 60, 'EUR', 'CRDT', '${daysAgo(5)}', null, 'Anna Rossi', null, null, null),
           ('pay-2', '${ACC}', '${A}', 70, 'EUR', 'CRDT', '${daysAgo(4)}', null, 'Mario Verdi', null, null, null);
    insert into public.payer_links (user_id, payer_key, contact) values ('${A}', 'anna rossi', 'Bea');`);
  const link = () => as(A, `select coalesce(string_agg(payer_key || '=' || contact, ','), '∅') from public.payer_links`);
  const flow = (ref) => admin(`select coalesce(flow_type, '∅') || '/' || coalesce(flow_source, '∅') from public.transactions where entry_reference = '${ref}'`);

  await t.test('before: undo with forget deletes the link it replaced', () => {
    as(A, `select public.record_payback('${ACC}', 'pay-1', 'Anna', true)`);
    as(A, `select public.undo_payback('${ACC}', 'pay-1', true)`);
    assert.strictEqual(link(), '∅');
    admin(`insert into public.payer_links (user_id, payer_key, contact) values ('${A}', 'anna rossi', 'Bea')`);
    applySql(`supabase/migrations/${NAME}.sql`);
    applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run
  });

  await t.test('an over-long settled_by_ref stored before is cleared; new ones are capped', () => {
    assert.strictEqual(admin(`select coalesce(settled_by_ref, '∅') from public.transactions where entry_reference = 'bill-1'`), '∅');
    assert.match(as(A, `update public.transactions set settled_by_ref = repeat('r', 1001) where entry_reference = 'bill-1'`), /transactions_settled_by_ref_length/);
  });

  await t.test('undo with forget puts back the link the payback replaced', () => {
    assert.match(as(A, `select public.record_payback('${ACC}', 'pay-1', 'Anna', true)`), /"linked": true/);
    assert.strictEqual(link(), 'anna rossi=Anna');
    as(A, `select public.undo_payback('${ACC}', 'pay-1', true)`);
    assert.strictEqual(link(), 'anna rossi=Bea');
  });

  await t.test('undo with forget still unlinks a link the payback made new', () => {
    as(A, `select public.record_payback('${ACC}', 'pay-2', 'Mario', true)`);
    as(A, `select public.undo_payback('${ACC}', 'pay-2', true)`);
    assert.strictEqual(link(), 'anna rossi=Bea');
  });

  await t.test('a flow set by hand comes back on undo; one the app chose goes back to the app', () => {
    as(A, `update public.transactions set flow_type = 'income' where entry_reference = 'pay-1'`);
    assert.strictEqual(flow('pay-1'), 'income/user');
    as(A, `select public.record_payback('${ACC}', 'pay-1', 'Anna', false)`);
    assert.strictEqual(flow('pay-1'), 'transfer/user');
    as(A, `select public.undo_payback('${ACC}', 'pay-1', false)`);
    assert.strictEqual(flow('pay-1'), 'income/user');
    // The app's own pick (here: none) is cleared for post-sync, as before.
    as(A, `select public.record_payback('${ACC}', 'pay-2', 'Mario', false)`);
    as(A, `select public.undo_payback('${ACC}', 'pay-2', false)`);
    assert.strictEqual(flow('pay-2'), '∅/∅');
  });

  await t.test('the rollback removes the new columns and functions keep working', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(admin(`select count(*) from pg_attribute where attname in ('payback_prior_flow', 'replaced_contact') and not attisdropped`), '0');
    assert.match(as(A, `select public.record_payback('${ACC}', 'pay-1', 'Anna', true)`), /"linked": true/);
    assert.doesNotMatch(as(A, `select public.undo_payback('${ACC}', 'pay-1', true)`), /ERROR/);
  });
});
