// H268: sync_cursors grants nothing to anon or authenticated (20270114000000_sync_cursors_server_only),
// the sync's service role keeps its access, and deleting the user still removes the cursors.
// Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270114000000_sync_cursors_server_only';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACC = 'aaaaaaaa-1111-0000-0000-000000000001';
const ACC2 = 'aaaaaaaa-1111-0000-0000-000000000002';

test('sync_cursors is server-only', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('sync_cursors_only', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC}', '${A}', 'EUR'), ('${ACC2}', '${A}', 'EUR');
    insert into public.sync_cursors (account_uid, last_synced) values ('${ACC}', '2026-01-01'), ('${ACC2}', '2026-01-01')`);
  applySql(`supabase/migrations/${NAME}.sql`);
  applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run

  await t.test('anon and signed-in users get permission denied, even with RLS off', () => {
    admin(`alter table public.sync_cursors disable row level security`);
    assert.match(as(A, `select count(*) from public.sync_cursors`), /permission denied/);
    assert.match(as(A, `delete from public.sync_cursors`), /permission denied/);
    admin(`alter table public.sync_cursors enable row level security`);
  });

  await t.test('the service role still reads it; deleting the user removes its cursors', () => {
    assert.strictEqual(admin(`select has_table_privilege('service_role', 'public.sync_cursors', 'select,insert,update,delete')`), 't');
    admin(`delete from auth.users where id = '${A}'`);
    assert.strictEqual(admin(`select count(*) from public.sync_cursors`), '0');
  });

  await t.test('the rollback restores the default grants', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(admin(`select has_table_privilege('authenticated', 'public.sync_cursors', 'select')`), 't');
  });
});
