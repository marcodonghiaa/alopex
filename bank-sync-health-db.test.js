// Enable Banking review: the bank-sync-health migration and its rollback, run for real against
// Postgres. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server); skipped
// without it. pg_net and Vault are stubbed: http_post records the account it would sync.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const U = 'aaaaaaaa-0000-0000-0000-000000000001';
const db = `bank_sync_health_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const UP = 'supabase/migrations/20261212000000_bank_sync_health.sql';
const DOWN = 'supabase/rollbacks/20261212000000_bank_sync_health.down.sql';

function psql(args) {
  return execFileSync('psql', [dbUrl(), '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const sql = (s) => psql(['-c', s]);
// Accounts sync_all_banks queued, by label.
const synced = () => {
  sql('truncate net.calls');
  sql('select count(*) from public.sync_all_banks()');
  return sql("select string_agg(a.label, ',' order by a.label) from net.calls c join public.accounts a on a.uid::text = c.account_uid");
};

test('bank-sync-health migration and rollback on a real database', { skip }, async (t) => {
  execFileSync('psql', [url, '-X', '-q', '-c', `create database ${db}`]);
  t.after(() => execFileSync('psql', [url, '-X', '-q', '-c', `drop database if exists ${db} with (force)`]));
  psql(['-f', 'supabase/tests/supabase-shim.sql']);
  sql(`create schema vault;
    create table vault.decrypted_secrets (name text, decrypted_secret text);
    insert into vault.decrypted_secrets values ('project_url', 'http://x/'), ('sync_bank_secret_key', 'k');
    create schema net;
    create table net.calls (account_uid text);
    create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds int) returns bigint
      language sql as $$ insert into net.calls values (body ->> 'account_uid'); select 1::bigint $$;
    create table public.accounts (
      uid uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id),
      label text, manual boolean not null default false, consent_valid_until timestamptz);
    insert into auth.users values ('${U}');
    insert into public.accounts (user_id, label, manual, consent_valid_until) values
      ('${U}', 'future', false, now() + interval '30 days'),
      ('${U}', 'today', false, date_trunc('day', now())),
      ('${U}', 'unknown', false, null),
      ('${U}', 'ended', false, now() - interval '2 days'),
      ('${U}', 'manual', true, null);`);
  psql(['-f', 'supabase/migrations/20261124000000_sync_all_banks_skip_manual.sql']);

  await t.test('applies twice and adds the columns', () => {
    psql(['-f', UP]);
    psql(['-f', UP]);
    assert.strictEqual(sql("select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name = 'accounts' and column_name in ('sync_error', 'sync_error_at', 'bank_session_id')"), 'bank_session_id,sync_error,sync_error_at');
  });

  await t.test('the cron skips ended consents and manual accounts, keeps today and unknown', () => {
    assert.strictEqual(synced(), 'future,today,unknown');
  });

  await t.test('a renewal brings an ended account back', () => {
    sql("update public.accounts set consent_valid_until = now() + interval '180 days' where label = 'ended'");
    assert.strictEqual(synced(), 'ended,future,today,unknown');
  });

  await t.test('API roles still cannot start a run', () => {
    assert.strictEqual(sql("select bool_or(has_function_privilege(r, 'public.sync_all_banks()', 'execute')) from unnest(array['anon','authenticated','service_role']) r"), 'f');
  });

  await t.test('rollback drops the columns and syncs every bank account again', () => {
    sql("update public.accounts set consent_valid_until = now() - interval '2 days' where label = 'ended'");
    psql(['-f', DOWN]);
    assert.strictEqual(sql("select count(*) from information_schema.columns where table_name = 'accounts' and column_name in ('sync_error', 'sync_error_at', 'bank_session_id')"), '0');
    assert.strictEqual(synced(), 'ended,future,today,unknown');
  });

  await t.test('re-applies after a rollback', () => {
    psql(['-f', UP]);
    assert.strictEqual(synced(), 'future,today,unknown');
  });
});
