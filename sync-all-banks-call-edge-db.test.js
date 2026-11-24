// H087: sync_all_banks goes through call_edge_function instead of its own copy of the Vault and
// pg_net block (20270111000000_sync_all_banks_uses_call_edge_function), so the secret, URL, headers
// and timeout live in one place. Real Postgres, every migration; pg_net and Vault are stubbed.
// Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270111000000_sync_all_banks_uses_call_edge_function';
const U = 'aaaaaaaa-0000-0000-0000-000000000001';

test('sync_all_banks uses call_edge_function', { skip }, async (t) => {
  const { admin, applySql, drop } = fullChainDb('sync_all_edge', { upTo: NAME });
  t.after(drop);
  admin(`create table net.calls (url text, headers jsonb, body jsonb, timeout int);
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 0)
      returns bigint language sql as $$ insert into net.calls values (url, headers, body, timeout_milliseconds); select 1::bigint $$;
    drop view vault.decrypted_secrets;
    create table vault.decrypted_secrets (name text, decrypted_secret text);
    insert into vault.decrypted_secrets values ('project_url', 'http://x/'), ('sync_bank_secret_key', 'k');
    insert into auth.users (id) values ('${U}');
    insert into public.accounts (uid, user_id, currency, label, manual, consent_valid_until) values
      (gen_random_uuid(), '${U}', 'EUR', 'live', false, now() + interval '30 days'),
      (gen_random_uuid(), '${U}', 'EUR', 'ended', false, now() - interval '2 days'),
      (gen_random_uuid(), '${U}', 'EUR', 'manual', true, null);`);
  const calls = () => {
    admin('truncate net.calls');
    admin('select count(*) from public.sync_all_banks()');
    return admin(`select string_agg(c.url || ' ' || a.label || ' ' || (c.headers ->> 'apikey') || ' ' || c.timeout, ',' order by a.label)
      from net.calls c join public.accounts a on a.uid::text = c.body ->> 'account_uid'`);
  };
  const before = calls();

  await t.test('same calls as before, made by call_edge_function', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(calls(), before);
    assert.strictEqual(before, 'http://x/functions/v1/sync-bank live k 150000');
    assert.doesNotMatch(admin(`select prosrc from pg_proc where oid = 'public.sync_all_banks()'::regprocedure`), /vault|http_post/);
    assert.match(admin(`select prosrc from pg_proc where oid = 'public.sync_all_banks()'::regprocedure`), /call_edge_function\('sync-bank'/);
  });

  await t.test('missing secrets still fail loudly; API roles still cannot run it', () => {
    admin("delete from vault.decrypted_secrets where name = 'sync_bank_secret_key'");
    assert.throws(() => calls(), /Set the Vault secrets/);
    admin("insert into vault.decrypted_secrets values ('sync_bank_secret_key', 'k')");
    assert.strictEqual(admin(`select bool_or(has_function_privilege(r, 'public.sync_all_banks()', 'execute')) from unnest(array['anon','authenticated','service_role']) r`), 'f');
    assert.strictEqual(admin(`select array_to_string(proconfig, ',') || ' ' || prosecdef from pg_proc where oid = 'public.sync_all_banks()'::regprocedure`), 'search_path="" true');
  });

  await t.test('rollback restores the old body with the same calls; re-apply works', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.match(admin(`select prosrc from pg_proc where oid = 'public.sync_all_banks()'::regprocedure`), /http_post/);
    assert.strictEqual(calls(), before);
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(calls(), before);
  });
});
