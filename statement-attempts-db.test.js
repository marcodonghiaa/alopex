// H241: parse-statement claims one 'statement' attempt per call (20270113000000_statement_attempts),
// so a signed-in user can't loop PDFs into the owner's Gemini quota. Reuses splitwise_attempt.
// Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270113000000_statement_attempts';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

test('statement attempts', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('statement_attempts', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.splitwise_attempts (user_id, kind) values ('${A}', 'sync'), ('${A}', 'connect')`);
  const claim = (who) => admin(`select public.splitwise_attempt('${who}', 'statement', 2, '10 minutes')`);

  await t.test('before: the statement kind is refused', () => {
    assert.throws(() => claim(A), /splitwise_attempts_kind_check/);
  });

  await t.test('existing rows survive the migration, which is safe to re-run', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(admin(`select count(*) from public.splitwise_attempts`), '2');
  });

  await t.test('p_max statement calls get through per user, then false', () => {
    assert.strictEqual(claim(A), 't');
    assert.strictEqual(claim(A), 't');
    assert.strictEqual(claim(A), 'f');
    assert.strictEqual(claim(B), 't');
    // Other kinds have their own count.
    assert.strictEqual(admin(`select public.splitwise_attempt('${A}', 'connect', 2, '10 minutes')`), 't');
  });

  await t.test('signed-in users still cannot claim or read attempts themselves', () => {
    assert.match(as(A, `select public.splitwise_attempt('${A}', 'statement', 100, '1 second')`), /permission denied/);
    assert.match(as(A, `select count(*) from public.splitwise_attempts`), /permission denied/);
  });

  await t.test('the rollback removes statement rows and restores the old kinds', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(admin(`select count(*) from public.splitwise_attempts where kind = 'statement'`), '0');
    assert.throws(() => claim(A), /splitwise_attempts_kind_check/);
    applySql(`supabase/migrations/${NAME}.sql`);
  });
});
