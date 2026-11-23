// fx_backfill_needed (20261230000000_fx_backfill_splitwise) also asks for rates back to the oldest
// foreign-currency Splitwise share not linked to a bank row: without one, v_splitwise_eur has no
// euro amount for it and the share drops out of spend. Needs psql and RLS_TEST_DATABASE_URL (a
// superuser URL to a scratch Postgres).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const db = `fx_backfill_sw_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const NAME = '20261230000000_fx_backfill_splitwise';
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACC = 'aaaaaaaa-1111-0000-0000-000000000001';

const psql = (target, args) => execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const sql = (q) => psql(dbUrl(), ['-c', q]);
const applySql = (file) => execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
  input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
  stdio: ['pipe', 'pipe', 'pipe'],
});
const gaps = () => sql(`select coalesce(string_agg(currency || ':' || from_date || '..' || to_date, ',' order by currency), '')
  from public.fx_backfill_needed()`);

test('fx backfill covers Splitwise shares', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  // Rates from 2026-08-01. A USD bank row on 2026-09-01 needs none; Splitwise has a GBP share from
  // 2026-03-01 and an older USD one, and a CHF share linked to a bank row (that row counts, not it).
  sql(`insert into auth.users (id) values ('${A}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC}', '${A}', 'EUR');
    insert into public.fx_rates (currency, date, rate_to_eur) values ('USD', '2026-08-01', 1.1), ('GBP', '2026-08-01', 0.85), ('CHF', '2026-08-01', 0.95);
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date)
    values ('t1', '${ACC}', '${A}', 10, 'USD', 'DBIT', '2026-09-01');
    insert into public.splitwise_expenses (user_id, group_name, fingerprint, booking_date, description, amount, currency, batch_id, linked_account_uid, linked_entry_reference)
    values ('${A}', 'g', 'f1', '2026-03-01', 'Hotel', 40, 'GBP', gen_random_uuid(), null, null),
           ('${A}', 'g', 'f2', '2026-05-01', 'Taxi', 15, 'USD', gen_random_uuid(), null, null),
           ('${A}', 'g', 'f3', '2026-01-01', 'Ski', 90, 'CHF', gen_random_uuid(), '${ACC}', 't1');`);
  const before = gaps();
  applySql(`supabase/migrations/${NAME}.sql`);
  applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run

  await t.test('unlinked foreign Splitwise shares older than the first rate need a backfill', () => {
    assert.strictEqual(gaps(), 'GBP:2026-03-01..2026-08-01,USD:2026-05-01..2026-08-01');
  });

  await t.test('still service role only', () => {
    assert.strictEqual(sql(`select has_function_privilege('authenticated', 'public.fx_backfill_needed()', 'execute')
      || ',' || has_function_privilege('service_role', 'public.fx_backfill_needed()', 'execute')`), 'false,true');
  });

  await t.test('rolls back to bank rows only', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(gaps(), before);
    assert.strictEqual(before, '');
  });
});
