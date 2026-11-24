// v_transactions_eur's payer_name on a real Postgres with every migration (the live view and the
// shipped RLS policies, not a hand-made copy): the payer on an incoming payment, your own name for
// the row first, and still only your own rows (the view runs as the caller).
// Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server); skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACC_A = 'aaaaaaaa-1111-0000-0000-000000000001';
const ACC_B = 'bbbbbbbb-1111-0000-0000-000000000002';

test('v_transactions_eur payer_name', { skip }, async (t) => {
  const { admin, as, drop } = fullChainDb('payer_name');
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC_A}', '${A}', 'EUR'), ('${ACC_B}', '${B}', 'EUR');
    insert into public.transactions (user_id, entry_reference, account_uid, booking_date, creditor_name, debtor_name, custom_name, currency, amount, credit_debit_indicator) values
      ('${A}', 'salary', '${ACC_A}', '2026-11-01', 'Me Myself', 'Acme Srl', null, 'EUR', 2000, 'CRDT'),
      ('${A}', 'renamed', '${ACC_A}', '2026-11-02', null, 'Old Payer', 'Freelance gig', 'EUR', 300, 'CRDT'),
      ('${A}', 'nobody', '${ACC_A}', '2026-11-03', null, null, null, 'EUR', 5, 'CRDT'),
      ('${B}', 'other', '${ACC_B}', '2026-11-01', null, 'Secret Payer', null, 'EUR', 9, 'CRDT');`);

  await t.test('names the payer, preferring the name you gave the row', () => {
    assert.strictEqual(
      as(A, "select string_agg(entry_reference || '=' || coalesce(payer_name, '∅'), ',' order by entry_reference) from public.v_transactions_eur"),
      'nobody=∅,renamed=Freelance gig,salary=Acme Srl',
    );
  });

  await t.test("keeps another user's payers out", () => {
    assert.strictEqual(as(B, "select string_agg(payer_name, ',') from public.v_transactions_eur"), 'Secret Payer');
    assert.strictEqual(as(B, "select count(*) from public.v_transactions_eur where payer_name = 'Acme Srl'"), '0');
    assert.strictEqual(admin(`begin; set local role anon; select count(*) from public.v_transactions_eur; rollback;`), '0');
  });
});
