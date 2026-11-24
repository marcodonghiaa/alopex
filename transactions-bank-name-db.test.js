// H142: v_transactions_eur gives the bank's own name too (20270104000000_transactions_bank_name), so
// "Make a rule" can fill in the name rules match on, not the one you renamed the row to. Real
// Postgres with every migration before it. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to
// a throwaway server); skipped without it. A fresh database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const NAME = '20270104000000_transactions_bank_name';
const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACC_A = 'aaaaaaaa-1111-0000-0000-000000000001';
const db = `tx_bank_name_${process.pid}`;
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
const as = (sub, q) => psql(dbUrl(), ['-c', `begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${sub}","role":"authenticated"}'; ${q}; commit;`]);
const columns = () => admin(`select string_agg(attname, ',' order by attnum) from pg_attribute where attrelid = 'public.v_transactions_eur'::regclass and attnum > 0`);

test('v_transactions_eur gives the bank name next to the shown name', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  const before = columns();
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC_A}', '${A}', 'EUR');
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, custom_name)
    values ('r1', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '2026-02-10', 'AMZN Mktp DE*123', 'Amazon'),
           ('r2', '${ACC_A}', '${A}', 5, 'EUR', 'DBIT', '2026-02-11', 'Lidl', null);`);

  await t.test('renamed row: creditor_name is the shown name, bank_creditor_name the bank one', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(
      as(A, `select string_agg(entry_reference || '|' || creditor_name || '|' || bank_creditor_name, ',' order by entry_reference) from public.v_transactions_eur`),
      'r1|Amazon|AMZN Mktp DE*123,r2|Lidl|Lidl',
    );
  });

  await t.test('only appends a column, still security_invoker, safe to re-run', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(columns(), `${before},bank_creditor_name`);
    assert.match(admin(`select array_to_string(reloptions, ',') from pg_class where oid = 'public.v_transactions_eur'::regclass`), /security_invoker=true/);
  });

  await t.test('rollback runs', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
  });
});
