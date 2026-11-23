// claim_push_subscription (20261231000000_claim_push_subscription): one browser's push endpoint
// belongs to whoever enabled check-ins last on it. Before, user B on a browser user A had used
// got a duplicate-key error (RLS hid A's row) and A's pushes kept landing there (H018).
// Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a scratch Postgres).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const db = `claim_push_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const NAME = '20261231000000_claim_push_subscription';
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const EP = 'https://push.example.com/send/abc';

const psql = (target, args) => execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const sql = (q) => psql(dbUrl(), ['-c', q]);
const as = (who, q) => psql(dbUrl(), ['-c', `begin; set local role ${who ? 'authenticated' : 'anon'};
  set local request.jwt.claims = '${who ? `{"sub":"${who}","role":"authenticated"}` : '{"role":"anon"}'}'; ${q}; commit;`]);
const claim = (who, ep = EP) => as(who, `select public.claim_push_subscription('${ep}', 'key-${who}', 'auth-${who}')`);
const applySql = (file) => execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
  input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
  stdio: ['pipe', 'pipe', 'pipe'],
});
const owners = () => sql(`select string_agg(user_id || ':' || p256dh, ',' order by user_id) from public.push_subscriptions`);

test('claim_push_subscription', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  sql(`insert into auth.users (id) values ('${A}'), ('${B}')`);
  applySql(`supabase/migrations/${NAME}.sql`);
  applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run

  await t.test('the next user on the same browser takes the endpoint over', () => {
    claim(A);
    assert.strictEqual(owners(), `${A}:key-${A}`);
    claim(B);
    assert.strictEqual(owners(), `${B}:key-${B}`);
  });

  await t.test('claiming again refreshes the keys, still one row', () => {
    as(B, `select public.claim_push_subscription('${EP}', 'new-key', 'new-auth')`);
    assert.strictEqual(owners(), `${B}:new-key`);
  });

  await t.test('other endpoints are left alone', () => {
    claim(A, 'https://push.example.com/send/other');
    assert.strictEqual(sql(`select count(*) from public.push_subscriptions`), '2');
  });

  await t.test('signed-out callers and non-https endpoints are refused', () => {
    assert.throws(() => claim(null), /permission denied|not signed in/);
    assert.throws(() => claim(A, 'http://push.example.com/x'), /endpoint/);
  });

  await t.test('rolls back: the function is gone', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(sql(`select count(*) from pg_proc where proname = 'claim_push_subscription'`), '0');
  });
});
