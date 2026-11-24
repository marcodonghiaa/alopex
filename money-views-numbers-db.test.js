// H092: the numbers every user sees, computed by the live views on a real Postgres with every
// migration: v_net_worth_eur, v_net_worth_daily (bank, debts, foreign currency, manual carry-forward,
// the 30-day bank cut-off), v_spend_by_category_monthly and v_income_vs_expenses_monthly (split
// share, refund pair, transfer, Splitwise share, uncategorized), and another user's isolation.
// Also pins what a missing exchange rate does today: the amount is left out (null), not guessed.
// Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const CHK = 'aaaaaaaa-1111-0000-0000-000000000001';
const OLD = 'aaaaaaaa-1111-0000-0000-000000000002';
const CARD = 'aaaaaaaa-1111-0000-0000-000000000003';
const USD = 'aaaaaaaa-1111-0000-0000-000000000004';
const GBP = 'aaaaaaaa-1111-0000-0000-000000000005';
const MAN = 'aaaaaaaa-1111-0000-0000-000000000006';
const ACC_B = 'bbbbbbbb-1111-0000-0000-000000000001';

test('money views give exact numbers', { skip }, async (t) => {
  const { admin, as, drop } = fullChainDb('money_views');
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.fx_rates (currency, date, rate_to_eur) values ('USD', '2026-10-01', 0.9), ('USD', '2026-11-01', 0.8);
    insert into public.accounts (uid, user_id, currency, account_type, manual) values
      ('${CHK}', '${A}', 'EUR', 'checking', false), ('${OLD}', '${A}', 'EUR', 'checking', false),
      ('${CARD}', '${A}', 'EUR', 'credit_card', false), ('${USD}', '${A}', 'USD', 'savings', false),
      ('${GBP}', '${A}', 'GBP', 'savings', false), ('${MAN}', '${A}', 'EUR', null, true),
      ('${ACC_B}', '${B}', 'EUR', 'checking', false);
    insert into public.net_worth_snapshots (account_uid, user_id, currency, amount, snapshot_date) values
      ('${OLD}', '${A}', 'EUR', 999, '2026-09-01'),
      ('${MAN}', '${A}', 'EUR', 50, '2026-10-01'),
      ('${CHK}', '${A}', 'EUR', 1000, '2026-10-15'), ('${USD}', '${A}', 'USD', 500, '2026-10-15'),
      ('${CHK}', '${A}', 'EUR', 1200, '2026-11-10'), ('${USD}', '${A}', 'USD', 500, '2026-11-10'),
      ('${CARD}', '${A}', 'EUR', -300, '2026-11-10'), ('${GBP}', '${A}', 'GBP', 200, '2026-11-10'),
      ('${ACC_B}', '${B}', 'EUR', 7, '2026-11-10');
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, category, flow_type, personal_amount) values
      ('groceries', '${CHK}', '${A}', 100, 'EUR', 'DBIT', '2026-11-03', 'Groceries', 'spend', null),
      ('dinner', '${CHK}', '${A}', 90, 'EUR', 'DBIT', '2026-11-04', 'Dining', 'spend', 30),
      ('shoes', '${CHK}', '${A}', 40, 'EUR', 'DBIT', '2026-11-05', 'Shopping', 'refunded', null),
      ('shoes-back', '${CHK}', '${A}', 40, 'EUR', 'CRDT', '2026-11-06', 'Shopping', 'refunded', null),
      ('to-savings', '${CHK}', '${A}', 200, 'EUR', 'DBIT', '2026-11-07', null, 'transfer', null),
      ('misc', '${CHK}', '${A}', 10, 'EUR', 'DBIT', '2026-11-08', null, 'spend', null),
      ('salary', '${CHK}', '${A}', 2000, 'EUR', 'CRDT', '2026-11-01', 'Salary', 'income', null),
      ('usd-taxi', '${USD}', '${A}', 50, 'USD', 'DBIT', '2026-11-05', 'Travel', 'spend', null),
      ('usd-early', '${USD}', '${A}', 100, 'USD', 'DBIT', '2026-09-15', 'Travel', 'spend', null),
      ('b-spend', '${ACC_B}', '${B}', 5, 'EUR', 'DBIT', '2026-11-03', 'Groceries', 'spend', null);
    insert into public.splitwise_expenses (user_id, group_name, fingerprint, booking_date, description, category, amount, currency, batch_id)
      values ('${A}', 'Trip', 'f1', '2026-11-07', 'Hotel', 'Travel', 60, 'EUR', gen_random_uuid());`);

  await t.test('net worth: bank plus manual minus debts, USD at the day rate, old bank balances dropped', () => {
    const day = (d) => as(A, `select concat_ws(' ', total_eur::numeric(12,2), bank_total_eur::numeric(12,2), liabilities_eur::numeric(12,2)) from public.v_net_worth_daily where snapshot_date = '${d}'`);
    // 10-15: 1000 + 500 USD x 0.9 + 50 manual (carried from 10-01); the 09-01 balance is over 30 days old.
    assert.strictEqual(day('2026-10-15'), '1500.00 1500.00 0.00');
    // 11-10: 1200 + 500 x 0.8 + 50 - 300 card; GBP has no rate and is left out.
    assert.strictEqual(day('2026-11-10'), '1350.00 1650.00 300.00');
    assert.strictEqual(day('2026-09-01'), '999.00 999.00 0.00');
  });

  await t.test('v_net_worth_eur converts each snapshot at its own date; a missing rate stays null', () => {
    assert.strictEqual(as(A, `select string_agg(currency || ' ' || snapshot_date || ' ' || coalesce(amount_eur::numeric(12,2)::text, 'null'), ',' order by snapshot_date, currency)
      from public.v_net_worth_eur where currency <> 'EUR'`), 'USD 2026-10-15 450.00,GBP 2026-11-10 null,USD 2026-11-10 400.00');
  });

  await t.test('spend by category: your share of a split, Splitwise shares, refunds and transfers left out', () => {
    assert.strictEqual(as(A, `select string_agg(month || ' ' || category || ' ' || spend_eur::numeric(12,2), ',' order by month, category) from public.v_spend_by_category_monthly`),
      '2026-11-01 Dining 30.00,2026-11-01 Groceries 100.00,2026-11-01 Travel 100.00,2026-11-01 Uncategorized 10.00');
  });

  await t.test('income vs expenses: same spend total, income counted once', () => {
    assert.strictEqual(as(A, `select string_agg(month || ' ' || income_eur::numeric(12,2) || ' ' || expenses_eur::numeric(12,2), ',' order by month) from public.v_income_vs_expenses_monthly where income_eur <> 0 or expenses_eur <> 0`),
      '2026-11-01 2000.00 240.00');
  });

  await t.test('a spend before the first rate of its currency is left out (pinned: null, not guessed)', () => {
    assert.strictEqual(as(A, `select coalesce(signed_amount_eur::text, 'null') from public.v_transactions_eur where entry_reference = 'usd-early'`), 'null');
    assert.strictEqual(as(A, `select count(*) from public.v_spend_by_category_monthly where month = '2026-09-01'`), '0');
  });

  await t.test("another user sees only their own numbers", () => {
    assert.strictEqual(as(B, `select string_agg(total_eur::numeric(12,2)::text, ',') from public.v_net_worth_daily`), '7.00');
    assert.strictEqual(as(B, `select string_agg(category || ' ' || spend_eur::numeric(12,2), ',') from public.v_spend_by_category_monthly`), 'Groceries 5.00');
    assert.strictEqual(as(B, `select count(*) from public.v_net_worth_eur where user_id = '${A}'`), '0');
    assert.strictEqual(as(B, `select count(*) from public.v_income_vs_expenses_monthly where user_id = '${A}'`), '0');
  });
});
