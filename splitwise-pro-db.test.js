// Splitwise Pro (20261216000000_splitwise_pro_required), run for real against Postgres on the full
// schema: a connection can be marked pro_required (the sync does, when Splitwise answers that the
// key's account has no Splitwise Pro), connecting again clears it, and the rollback turns it back
// into needs_reconnect. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway
// server); skipped without it. A fresh database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const db = `splitwise_pro_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const NAME = '20261216000000_splitwise_pro_required';
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
const applySql = (file) => execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
  input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
  stdio: ['pipe', 'pipe', 'pipe'],
});
const status = () => sql(`select status from public.splitwise_connections where user_id = '${A}'`);

test('Splitwise Pro required, on a real Postgres', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  sql(`insert into auth.users (id) values ('${A}'); select public.splitwise_save_connection('${A}', 'key-a', 111, 'Ann')`);
  assert.match(sql(`update public.splitwise_connections set status = 'pro_required'`), /check constraint/, 'refused before');
  applySql(UP);

  await t.test('the sync can mark a connection pro_required; other unknown states are still refused', () => {
    sql(`update public.splitwise_connections set status = 'pro_required', last_error = 'no Pro' where user_id = '${A}'`);
    assert.strictEqual(status(), 'pro_required');
    assert.match(sql(`update public.splitwise_connections set status = 'bogus'`), /check constraint/);
    const seen = execFileSync('psql', [dbUrl(), '-X', '-q', '-t', '-A'], {
      input: `begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${A}"}';
        select connected || ',' || status from public.get_splitwise_connection(); rollback;`,
      encoding: 'utf8',
    }).trim();
    assert.strictEqual(seen, 'true,pro_required', 'the dashboard reads it');
  });

  await t.test('connecting again (a new key, or Pro renewed) clears it', () => {
    sql(`select public.splitwise_save_connection('${A}', 'key-b', 111, 'Ann')`);
    assert.strictEqual(status(), 'ok');
  });

  await t.test('rolls back to needs_reconnect, and applies again', () => {
    sql(`update public.splitwise_connections set status = 'pro_required' where user_id = '${A}'`);
    applySql(DOWN);
    assert.strictEqual(status(), 'needs_reconnect');
    assert.match(sql(`update public.splitwise_connections set status = 'pro_required'`), /check constraint/);
    applySql(UP);
    assert.strictEqual(sql(`update public.splitwise_connections set status = 'pro_required' returning status`), 'pro_required');
  });
});
