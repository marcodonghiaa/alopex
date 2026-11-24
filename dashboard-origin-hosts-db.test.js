// H083: register_dashboard_origin accepts real production hosts whose team or user slug happens to be
// 9 characters ("<project>-<user>s-projects.vercel.app"), and still refuses per-deployment hosts
// (a 9-character hash with letters and digits) and branch hosts (20270109000000_dashboard_origin_hosts).
// Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270109000000_dashboard_origin_hosts';
const OWNER = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000002';

test('register_dashboard_origin hosts', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('origin_hosts', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id, created_at) values ('${OWNER}', now() - interval '1 day'), ('${OTHER}', now());`);
  const reg = (origin, who = OWNER) => as(who, `select set_config('request.headers', '${JSON.stringify({ origin })}', true);
    select public.register_dashboard_origin()`).split('\n').pop();

  await t.test('a 9-character user slug in a production alias is accepted', () => {
    assert.strictEqual(reg('https://alopex-christina-projects.vercel.app'), 'rejected'); // before
    applySql(`supabase/migrations/${NAME}.sql`);
    admin('delete from public.dashboard_origins');
    assert.strictEqual(reg('https://alopex-christina-projects.vercel.app'), 'added');
    assert.strictEqual(reg('https://alopex-ab12cd-marcellos-projects.vercel.app'), 'added');
  });

  await t.test('deployment and branch hosts, http and garbage are still refused', () => {
    assert.strictEqual(reg('https://my-finances-abc123xyz-marco.vercel.app'), 'rejected');
    assert.strictEqual(reg('https://alopex-7h2kq9zxw-christinas-projects.vercel.app'), 'rejected');
    assert.strictEqual(reg('https://my-finances-git-main-marco.vercel.app'), 'rejected');
    assert.strictEqual(reg('http://my-finances.vercel.app'), 'rejected');
    assert.strictEqual(reg('not an origin'), 'rejected');
  });

  await t.test('other rules unchanged: owner only, idempotent, lowercased, cap of 5', () => {
    assert.strictEqual(reg('https://evil.example.com', OTHER), 'not_owner');
    assert.strictEqual(reg('HTTPS://Alopex-Christina-Projects.vercel.app'), 'exists');
    assert.strictEqual(reg('http://localhost:3000'), 'added');
    assert.strictEqual(reg('https://a.example.com'), 'added');
    assert.strictEqual(reg('https://b.example.com'), 'added');
    assert.strictEqual(reg('https://c.example.com'), 'full');
    assert.strictEqual(admin(`select array_to_string(proconfig, ',') from pg_proc where oid = 'public.register_dashboard_origin()'::regprocedure`), 'search_path=""');
  });

  await t.test('rollback restores the old rule; re-apply works', () => {
    admin('delete from public.dashboard_origins');
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(reg('https://alopex-christina-projects.vercel.app'), 'rejected');
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(reg('https://alopex-christina-projects.vercel.app'), 'added');
  });
});
