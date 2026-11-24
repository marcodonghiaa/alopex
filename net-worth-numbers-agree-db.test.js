// Net worth numbers agree (20270103000000_net_worth_numbers_agree), on a real Postgres with every
// migration before it:
// - H099: a manual account in another currency is converted at the latest rate on the Accounts
//   page (v_bank_accounts_latest), as net worth (v_net_worth_daily) already did, not at the rate
//   of the day its balance was typed in.
// - H091: a month's imported spend total (spend_history) is replaced only by real bank spend, as
//   the live branch counts it, not by any 'spend' row (a zero share or a credit).
// Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server); skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const NAME = '20270103000000_net_worth_numbers_agree';
const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACC = 'aaaaaaaa-1111-0000-0000-000000000001';
const MAN = 'aaaaaaaa-2222-0000-0000-000000000001';
const db = `nw_agree_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();

const psql = (target, args) => execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const admin = (q) => psql(dbUrl(), ['-c', q]);
const applySql = (file) => execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
  input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
  stdio: ['pipe', 'pipe', 'pipe'],
});
const as = (q) => psql(dbUrl(), ['-c', `begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${A}","role":"authenticated"}'; ${q}; commit;`]);
const accountsEur = () => as(`select amount_eur::numeric(12,2) from public.v_bank_accounts_latest where uid = '${MAN}'`);
const netWorthEur = () => as(`select bank_total_eur::numeric(12,2) from public.v_net_worth_daily order by snapshot_date desc limit 1`);
const spend = () => as(`select coalesce(string_agg(month || ' ' || s::numeric(12,2), ',' order by month), '') from (select month, sum(spend_eur) s from public.v_spend_by_category_monthly group by month) x`);
const expenses = () => as(`select coalesce(string_agg(month || ' ' || expenses_eur::numeric(12,2), ',' order by month), '') from public.v_income_vs_expenses_monthly`);
const columns = (v) => admin(`select string_agg(attname || ' ' || format_type(atttypid, atttypmod), ',' order by attnum) from pg_attribute where attrelid = 'public.${v}'::regclass and attnum > 0`);

test('net worth numbers agree', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  const before = [columns('v_bank_accounts_latest'), columns('v_spend_by_category_monthly')];
  // A USD manual account typed in on 1 Oct (rate 0.90), priced today at 0.80. A bank account
  // gives net worth a row for today. March was imported (300); its only bank 'spend' row is a
  // share of 0, paid entirely for others.
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.accounts (uid, user_id, currency, label) values ('${ACC}', '${A}', 'EUR', 'Bank');
    insert into public.accounts (uid, user_id, currency, label, manual) values ('${MAN}', '${A}', 'USD', 'Dollars', true);
    insert into public.fx_rates (date, currency, rate_to_eur) values ('2026-10-01', 'USD', 0.90), (current_date, 'USD', 0.80);
    insert into public.net_worth_snapshots (account_uid, user_id, currency, amount, snapshot_date) values
      ('${MAN}', '${A}', 'USD', 1000, '2026-10-01'), ('${ACC}', '${A}', 'EUR', 0, current_date);
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, category, personal_amount)
      values ('for-others', '${ACC}', '${A}', 40, 'EUR', 'DBIT', '2026-03-10', 'Dine Out', 0);
    update public.transactions set flow_type = 'spend' where entry_reference = 'for-others';
    insert into public.spend_history (user_id, month, category, spend_eur) values ('${A}', '2026-03-01', 'Rent', 300);`);
  // Before: the two pages disagree, and March's import is hidden by a zero share.
  assert.strictEqual(accountsEur(), '900.00');
  assert.strictEqual(netWorthEur(), '800.00');
  assert.strictEqual(spend(), '');

  await t.test('the Accounts page converts the manual account like net worth', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(accountsEur(), '800.00');
    assert.strictEqual(netWorthEur(), '800.00');
  });

  await t.test('a rate dated after today is not used yet, like net worth', () => {
    admin(`insert into public.fx_rates (date, currency, rate_to_eur) values (current_date + 1, 'USD', 0.50)`);
    assert.strictEqual(accountsEur(), '800.00');
    admin(`delete from public.fx_rates where date > current_date`);
  });

  await t.test("an imported month stays until it has real bank spend", () => {
    assert.strictEqual(spend(), '2026-03-01 300.00');
    assert.strictEqual(expenses(), '2026-03-01 300.00'); // Income vs expenses follows Spending
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, category)
      values ('real', '${ACC}', '${A}', 25, 'EUR', 'DBIT', '2026-03-12', 'Groceries');
      update public.transactions set flow_type = 'spend' where entry_reference = 'real';`);
    assert.strictEqual(spend(), '2026-03-01 25.00');
  });

  await t.test('same columns, still security_invoker, safe to re-run, and the rollback restores both', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.deepStrictEqual([columns('v_bank_accounts_latest'), columns('v_spend_by_category_monthly')], before);
    for (const v of ['v_bank_accounts_latest', 'v_spend_by_category_monthly']) {
      assert.match(admin(`select array_to_string(reloptions, ',') from pg_class where oid = 'public.${v}'::regclass`), /security_invoker=true/);
    }
    admin(`delete from public.transactions where entry_reference = 'real'`);
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(accountsEur(), '900.00');
    assert.strictEqual(spend(), ''); // the zero share hides the import again
  });
});
