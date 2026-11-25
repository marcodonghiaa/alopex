// H269: transactions.category and pending_bank_consents.origin were unbounded though users write
// them directly (20270117000000_user_text_length_caps). A signed-in user's new or changed category
// is capped at 100 characters (checked on change only, like rule text in 20261211000000, so an old
// long row never blocks other edits or the sync); an origin at 300.
// Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270117000000_user_text_length_caps';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACC = 'aaaaaaaa-1111-0000-0000-000000000001';
const LONG = 'x'.repeat(101);

test('user text length caps', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('user_text_caps', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC}', '${A}', 'EUR');
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, category)
      values ('old', '${ACC}', '${A}', 5, 'EUR', 'DBIT', '2026-01-01', '${LONG}'), ('b1', '${ACC}', '${A}', 5, 'EUR', 'DBIT', '2026-01-01', null);
    insert into public.pending_bank_consents (user_id, origin) values ('${A}', 'https://${'o'.repeat(400)}.example'), ('${A}', 'https://ok.example')`);
  const setCategory = (ref, value) => as(A, `update public.transactions set category = '${value}' where entry_reference = '${ref}'`);
  const consent = (origin) => as(A, `insert into public.pending_bank_consents (user_id, origin) values ('${A}', '${origin}')`);

  await t.test('before: a signed-in user can store any length', () => {
    assert.doesNotMatch(setCategory('b1', 'y'.repeat(5000)), /ERROR/);
    admin(`update public.transactions set category = null where entry_reference = 'b1'`);
    applySql(`supabase/migrations/${NAME}.sql`);
    applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run
  });

  await t.test('a signed-in user can set up to 100 characters, not more', () => {
    assert.doesNotMatch(setCategory('b1', 'y'.repeat(100)), /ERROR/);
    assert.match(setCategory('b1', LONG), /transactions_category_length/);
  });

  await t.test('an old long category is kept and blocks no other edit', () => {
    assert.strictEqual(admin(`select char_length(category) from public.transactions where entry_reference = 'old'`), '101');
    assert.doesNotMatch(as(A, `update public.transactions set note = 'n' where entry_reference = 'old'`), /ERROR/);
    assert.doesNotMatch(setCategory('old', 'Groceries'), /ERROR/);
  });

  await t.test('server writes (the sync, rules) are not refused', () => {
    assert.doesNotMatch(admin(`update public.transactions set category = '${LONG}' where entry_reference = 'b1'`), /ERROR/);
  });

  await t.test('a bogus over-long pending origin is removed; new ones are capped at 300', () => {
    assert.strictEqual(admin(`select string_agg(origin, ',') from public.pending_bank_consents`), 'https://ok.example');
    assert.doesNotMatch(consent(`https://${'a'.repeat(253)}`), /ERROR/);
    assert.match(consent(`https://${'a'.repeat(300)}`), /pending_bank_consents_origin_length/);
    assert.strictEqual(admin(`select convalidated from pg_constraint where conname = 'pending_bank_consents_origin_length'`), 't');
  });

  await t.test('the rollback removes both caps', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.doesNotMatch(setCategory('b1', LONG), /ERROR/);
    assert.doesNotMatch(consent(`https://${'a'.repeat(300)}`), /ERROR/);
  });
});
