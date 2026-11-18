// Enable Banking review: the bank-sync-health migration and its rollback, run for real against
// Postgres. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server); skipped
// without it. pg_net and Vault are stubbed: http_post records the account it would sync.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const U = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
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
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
// pg_net and pg_cron are stubbed by full-schema-shim.sql.
const applySql = (file) =>
  execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
    input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const asUser = (id, s) => sql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${id}","role":"authenticated"}'; ${s}; commit;`);
const asOwner = (s) => asUser(U, s);
const asAnon = (s) => sql(`begin; set local role anon; ${s}; commit;`);
// Rows an API update touched.
const updated = (s) => `with u as (${s} returning 1) select count(*) from u`;
// Accounts sync_all_banks queued, by label.
const synced = () => {
  sql('truncate net.calls');
  sql('select count(*) from public.sync_all_banks()');
  return sql("select string_agg(a.label, ',' order by a.label) from net.calls c join public.accounts a on a.uid::text = c.account_uid");
};

test('bank-sync-health migration and rollback on a real database', { skip }, async (t) => {
  execFileSync('psql', [url, '-X', '-q', '-c', `create database ${db}`]);
  t.after(() => execFileSync('psql', [url, '-X', '-q', '-c', `drop database if exists ${db} with (force)`]));
  psql(['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  // The real schema up to this migration.
  for (const f of MIGRATIONS.filter((f) => f < UP.split('/').pop())) applySql(`supabase/migrations/${f}`);
  // pg_net records the account it would sync; Vault answers the two secrets.
  sql(`create table net.calls (account_uid text);
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 0)
      returns bigint language sql as $$ insert into net.calls values (body ->> 'account_uid'); select 1::bigint $$;
    drop view vault.decrypted_secrets;
    create table vault.decrypted_secrets (name text, decrypted_secret text);
    insert into vault.decrypted_secrets values ('project_url', 'http://x/'), ('sync_bank_secret_key', 'k');
    insert into auth.users (id) values ('${U}'), ('${B}');
    insert into public.accounts (uid, user_id, currency, label, manual, consent_valid_until) values
      (gen_random_uuid(), '${U}', 'EUR', 'future', false, now() + interval '30 days'),
      (gen_random_uuid(), '${U}', 'EUR', 'today', false, now() + interval '1 hour'),
      (gen_random_uuid(), '${U}', 'EUR', 'midnight', false, date_trunc('day', now())),
      (gen_random_uuid(), '${U}', 'EUR', 'unknown', false, null),
      (gen_random_uuid(), '${U}', 'EUR', 'ended', false, now() - interval '2 days'),
      (gen_random_uuid(), '${U}', 'EUR', 'manual', true, null),
      (gen_random_uuid(), '${B}', 'EUR', 'other user', true, null);`);

  await t.test('applies twice and adds the columns', () => {
    applySql(UP);
    applySql(UP);
    assert.strictEqual(sql("select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name = 'accounts' and column_name in ('sync_error', 'sync_error_at', 'bank_session_id')"), 'bank_session_id,sync_error,sync_error_at');
  });

  await t.test('the cron skips ended consents (even earlier today) and manual accounts, keeps later today and unknown', () => {
    assert.strictEqual(synced(), 'future,today,unknown');
  });

  await t.test('the owner reads the sync error through the Accounts view', () => {
    sql("update public.accounts set sync_error = 'ASPSP_TIMEOUT', sync_error_at = now() where label = 'future'");
    assert.strictEqual(asOwner("select string_agg(label || ':' || coalesce(sync_error, '-'), ',' order by label) from public.v_bank_accounts_latest where label in ('future', 'today')"), 'future:ASPSP_TIMEOUT,today:-');
  });

  await t.test('another user and anon cannot read or change the new columns', () => {
    sql("update public.accounts set bank_session_id = 'sess-a' where label = 'future'");
    assert.strictEqual(asUser(B, "select count(*) from public.v_bank_accounts_latest where label = 'future'"), '0');
    assert.strictEqual(asUser(B, "select count(*) from public.accounts where user_id = '" + U + "' or true"), '1');
    assert.strictEqual(asUser(B, updated("update public.accounts set sync_error = 'X', bank_session_id = 'sess-b' where label = 'future'")), '0');
    // Only the Edge Functions (service role) write them: the owner cannot point its row at another session.
    assert.strictEqual(asOwner(updated("update public.accounts set bank_session_id = 'sess-b', sync_error = null where label = 'future'")), '0');
    assert.strictEqual(asAnon("select count(*) from public.v_bank_accounts_latest"), '0');
    assert.strictEqual(sql("select sync_error || ':' || bank_session_id from public.accounts where label = 'future'"), 'ASPSP_TIMEOUT:sess-a');
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
    applySql(DOWN);
    assert.strictEqual(sql("select count(*) from information_schema.columns where table_name = 'accounts' and column_name in ('sync_error', 'sync_error_at', 'bank_session_id')"), '0');
    assert.strictEqual(asOwner('select count(*) from public.v_bank_accounts_latest'), '5');
    assert.strictEqual(synced(), 'ended,future,midnight,today,unknown');
  });

  await t.test('re-applies after a rollback', () => {
    applySql(UP);
    assert.strictEqual(synced(), 'future,today,unknown');
  });
});
