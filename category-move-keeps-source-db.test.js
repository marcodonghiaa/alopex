// move_category (20261228000000_category_move_keeps_source) keeps each row's category_source: a
// rename or delete is not a hand pick, so AI and rule rows stay AI and rule. Needs psql and
// RLS_TEST_DATABASE_URL (a superuser URL to a scratch Postgres).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const db = `catmove_source_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const NAME = '20261228000000_category_move_keeps_source';
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACC = 'aaaaaaaa-1111-0000-0000-000000000001';

const psql = (target, args) => execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const sql = (q) => psql(dbUrl(), ['-c', q]);
const asA = (q) => psql(dbUrl(), ['-c', `begin; set local role authenticated;
  set local request.jwt.claims = '{"sub":"${A}","role":"authenticated"}'; ${q}; commit;`]);
const applySql = (file) => execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
  input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
  stdio: ['pipe', 'pipe', 'pipe'],
});
const seed = () => sql(`delete from public.transactions; delete from public.user_categories;
  insert into public.user_categories (user_id, name) values ('${A}', 'Holiday');
  insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, category, category_source)
  values ('ai', '${ACC}', '${A}', 10, 'EUR', 'DBIT', '2026-11-10', 'Holiday', 'ai'),
         ('rule', '${ACC}', '${A}', 20, 'EUR', 'DBIT', '2026-11-10', 'Holiday', 'rule'),
         ('manual', '${ACC}', '${A}', 30, 'EUR', 'DBIT', '2026-11-10', 'Holiday', 'manual')`);
const rows = () => sql(`select string_agg(entry_reference || '=' || category || '/' || category_source, ',' order by entry_reference)
  from public.transactions`);

test('move_category keeps category_source', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  sql(`insert into auth.users (id) values ('${A}'); insert into public.accounts (uid, user_id, currency) values ('${ACC}', '${A}', 'EUR');`);
  applySql(`supabase/migrations/${NAME}.sql`);
  applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run

  await t.test('a rename keeps AI, rule and manual rows as they were', () => {
    seed();
    assert.strictEqual(asA(`select public.move_category('Holiday', 'Trips')`), '3');
    assert.strictEqual(rows(), 'ai=Trips/ai,manual=Trips/manual,rule=Trips/rule');
  });

  await t.test('a category you pick by hand afterwards is still marked manual', () => {
    asA(`update public.transactions set category = 'Shopping' where entry_reference = 'ai'`);
    assert.match(rows(), /ai=Shopping\/manual/);
  });

  await t.test('rolls back to marking moved rows manual', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    seed();
    asA(`select public.move_category('Holiday', 'Trips')`);
    assert.strictEqual(rows(), 'ai=Trips/manual,manual=Trips/manual,rule=Trips/manual');
  });
});
