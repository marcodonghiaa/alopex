// Types you set by hand (20261219000000_transaction_type_source), run for real against Postgres on
// the full schema: a signed-in user's change to transaction_type marks it 'manual', and the sync,
// rules and AI (service role) can no longer overwrite it. The subscription detector reads the
// marker so a charge you marked One-time never rebuilds a subscription. Needs psql and
// RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server); skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACC = 'cccccccc-0000-0000-0000-000000000001';
const db = `type_source_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const NAME = '20261219000000_transaction_type_source';
const UP = `supabase/migrations/${NAME}.sql`;
const DOWN = `supabase/rollbacks/${NAME}.down.sql`;
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();

const psql = (target, args) => execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const sql = (q) => {
  try {
    return psql(dbUrl(), ['-c', q]);
  } catch (e) {
    return `ERROR ${String(e.stderr)}`;
  }
};
const asUser = (q) => sql(`set role authenticated; set request.jwt.claims = '{"sub":"${A}","role":"authenticated"}'; ${q}`);
const asService = (q) => sql(`set role service_role; set request.jwt.claims = '{"role":"service_role"}'; ${q}`);
const applySql = (file) => execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
  input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
  stdio: ['pipe', 'pipe', 'pipe'],
});
const row = (ref) => sql(`select coalesce(transaction_type, '-') || ':' || coalesce(transaction_type_source, '-')
  from public.transactions where entry_reference = '${ref}'`);

test('hand-set transaction types, on a real Postgres', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  sql(`insert into auth.users (id) values ('${A}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC}', '${A}', 'EUR');
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, transaction_type)
    values ('old', '${ACC}', '${A}', 3, 'EUR', 'DBIT', '2026-10-05', 'Apple.com', 'Subscription'),
           ('ai', '${ACC}', '${A}', 3, 'EUR', 'DBIT', '2026-11-05', 'Apple.com', 'Subscription')`);
  applySql(UP);
  applySql(UP); // safe to re-run

  await t.test('rows from before have no marker', () => {
    assert.strictEqual(row('old'), 'Subscription:-');
  });

  await t.test('your change marks the type as yours', () => {
    asUser(`update public.transactions set transaction_type = 'One-time' where entry_reference = 'old'`);
    assert.strictEqual(row('old'), 'One-time:manual');
  });

  await t.test('the sync, a rule or the AI cannot overwrite a type you set', () => {
    asService(`update public.transactions set transaction_type = 'Subscription' where entry_reference = 'old'`);
    assert.strictEqual(row('old'), 'One-time:manual');
    asService(`update public.transactions set transaction_type_source = null where entry_reference = 'old'`);
    assert.strictEqual(row('old'), 'One-time:manual');
  });

  await t.test('a type you did not set still changes as before, and other edits leave the marker alone', () => {
    asService(`update public.transactions set transaction_type = 'One-time' where entry_reference = 'ai'`);
    assert.strictEqual(row('ai'), 'One-time:-');
    asUser(`update public.transactions set category = 'Services' where entry_reference = 'ai'`);
    assert.strictEqual(row('ai'), 'One-time:-');
  });

  // Audit P1: a charge already showing One-time (set by the AI) could not be claimed as yours.
  await t.test('picking the type it already has, as yours, marks it', () => {
    asService(`update public.transactions set transaction_type = 'One-time' where entry_reference = 'ai'`);
    asUser(`update public.transactions set transaction_type = 'One-time', transaction_type_source = 'manual' where entry_reference = 'ai'`);
    assert.strictEqual(row('ai'), 'One-time:manual');
    asService(`update public.transactions set transaction_type = 'Subscription' where entry_reference = 'ai'`);
    assert.strictEqual(row('ai'), 'One-time:manual');
  });

  // Audit P3: an empty type you set leaves no marker, so the AI may fill it again.
  await t.test('clearing the type leaves no marker', () => {
    asUser(`update public.transactions set transaction_type = null, transaction_type_source = 'manual' where entry_reference = 'ai'`);
    assert.strictEqual(row('ai'), '-:-');
  });

  await t.test('you can change your own choice again', () => {
    asUser(`update public.transactions set transaction_type = 'Subscription' where entry_reference = 'old'`);
    assert.strictEqual(row('old'), 'Subscription:manual');
  });

  await t.test('only known markers are accepted', () => {
    assert.match(sql(`update public.transactions set transaction_type_source = 'bogus'`), /check constraint/);
  });

  await t.test('rolls back (column and trigger gone) and applies again', () => {
    applySql(DOWN);
    assert.match(sql(`select transaction_type_source from public.transactions limit 1`), /does not exist/);
    asService(`update public.transactions set transaction_type = 'One-time' where entry_reference = 'old'`);
    assert.strictEqual(sql(`select transaction_type from public.transactions where entry_reference = 'old'`), 'One-time');
    applySql(UP);
    asUser(`update public.transactions set transaction_type = 'Subscription' where entry_reference = 'old'`);
    assert.strictEqual(row('old'), 'Subscription:manual');
  });
});
