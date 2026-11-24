// H230: splitwise_connections gets last_attempt_at (20270121000000_splitwise_last_attempt), the
// cron's order (attempt, then last success) puts a user whose run was killed behind the others,
// and existing rows keep their order. Real Postgres, every migration. Needs psql and
// RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270121000000_splitwise_last_attempt';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'aaaaaaaa-0000-0000-0000-000000000002';
const ORDER = `select string_agg(user_id::text, ',' order by last_attempt_at asc nulls first, last_synced_at asc nulls first)
  from public.splitwise_connections where status in ('ok', 'error')`;

test('splitwise_connections.last_attempt_at', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('splitwise_last_attempt', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.splitwise_connections (user_id, splitwise_user_id, display_name, status, consent_at, last_synced_at)
    values ('${A}', 1, 'A', 'ok', now(), '2026-11-01'), ('${B}', 2, 'B', 'ok', now(), '2026-11-10')`);
  applySql(`supabase/migrations/${NAME}.sql`);
  applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run

  await t.test('existing rows start empty, so the first run keeps the old order', () => {
    assert.strictEqual(admin(`select count(*) from public.splitwise_connections where last_attempt_at is null`), '2');
    assert.strictEqual(admin(ORDER), `${A},${B}`);
  });

  await t.test('a user tried but never finished goes behind one not tried since', () => {
    admin(`update public.splitwise_connections set last_attempt_at = '2026-11-17T06:00Z' where user_id = '${A}';
      update public.splitwise_connections set last_attempt_at = '2026-11-10T00:00Z' where user_id = '${B}'`);
    assert.strictEqual(admin(ORDER), `${B},${A}`);
  });

  await t.test('still server-only', () => {
    assert.match(as(A, `select last_attempt_at from public.splitwise_connections`), /permission denied/);
  });

  await t.test('the rollback drops the column', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(admin(`select count(*) from information_schema.columns where table_name = 'splitwise_connections' and column_name = 'last_attempt_at'`), '0');
  });
});
