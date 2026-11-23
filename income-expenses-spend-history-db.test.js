// Income vs expenses counts imported spend history (20261226000000_income_expenses_spend_history) on
// a real Postgres with every migration before it: a month with only imported totals shows the same
// spending in v_income_vs_expenses_monthly as in v_spend_by_category_monthly; a month with bank
// spending ignores the import in both. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a
// throwaway server); skipped without it. A fresh database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const NAME = '20261226000000_income_expenses_spend_history';
const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACC_A = 'aaaaaaaa-1111-0000-0000-000000000001';
const db = `inc_exp_hist_${process.pid}`;
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
// As the signed-in user, the way the dashboard reads (RLS, security_invoker views).
const as = (sub, q) => psql(dbUrl(), ['-c', `begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${sub}","role":"authenticated"}'; ${q}; commit;`]);
const totals = (sub) => as(sub, `select coalesce(string_agg(month || ' ' || income_eur::numeric(12,2) || ' ' || expenses_eur::numeric(12,2), ',' order by month), '') from public.v_income_vs_expenses_monthly`);
const spend = (sub) => as(sub, `select coalesce(string_agg(month || ' ' || s::numeric(12,2), ',' order by month), '') from (select month, sum(spend_eur) s from public.v_spend_by_category_monthly group by month) x`);
const columns = () => admin(`select string_agg(attname || ' ' || format_type(atttypid, atttypmod), ',' order by attnum) from pg_attribute where attrelid = 'public.v_income_vs_expenses_monthly'::regclass and attnum > 0`);

test('income vs expenses counts imported spend history', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  const before = columns();
  // A: January is imported only (120 + 30); February has bank spend (50), income (1000) and an
  // imported total (999) that the bank month overrides. B has an imported month of their own.
  admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC_A}', '${A}', 'EUR');
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, category)
    values ('s1', '${ACC_A}', '${A}', 50, 'EUR', 'DBIT', '2026-02-10', 'Groceries'),
           ('i1', '${ACC_A}', '${A}', 1000, 'EUR', 'CRDT', '2026-02-01', 'Salary');
    update public.transactions set flow_type = 'income' where entry_reference = 'i1';
    update public.transactions set flow_type = 'spend' where entry_reference = 's1';
    insert into public.spend_history (user_id, month, category, spend_eur) values
      ('${A}', '2026-01-01', 'Rent', 120), ('${A}', '2026-01-01', 'Groceries', 30),
      ('${A}', '2026-02-01', 'Rent', 999), ('${B}', '2026-01-01', 'Rent', 70);`);

  await t.test('expenses match the Spending view: imported-only month counted, bank month ignores the import', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(spend(A), '2026-01-01 150.00,2026-02-01 50.00');
    assert.strictEqual(totals(A), '2026-01-01 0.00 150.00,2026-02-01 1000.00 50.00');
    assert.strictEqual(totals(B), '2026-01-01 0.00 70.00');
  });

  await t.test('same columns, still security_invoker, safe to re-run', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(columns(), before);
    assert.match(admin(`select array_to_string(reloptions, ',') from pg_class where oid = 'public.v_income_vs_expenses_monthly'::regclass`), /security_invoker=true/);
  });

  await t.test('rollback restores the old view (imported months not counted)', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(columns(), before);
    assert.strictEqual(totals(A), '2026-02-01 1000.00 50.00');
  });
});
