// H127: Undo or Restore of a removed subscription puts back what it was before
// (20270105000000_stream_undo_keeps_status). Before, a confirmed stream the detector still called
// 'suggested' came back as "To review", or vanished when that suggestion was stale. Real Postgres
// with every migration before it. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a
// throwaway server); skipped without it. A fresh database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const NAME = '20270105000000_stream_undo_keeps_status';
const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const db = `stream_undo_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();

const psql = (target, args) => execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const admin = (q) => psql(dbUrl(), ['-c', q]);
const applySql = (file) => execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
  input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
  stdio: ['pipe', 'pipe', 'pipe'],
});
const as = (q) => psql(dbUrl(), ['-c', `begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${A}","role":"authenticated"}'; ${q}; commit;`]);
const act = (key, action) => as(`select public.stream_action((select id from public.recurring_streams where stream_key = '${key}'), '${action}')`);
const status = (key) => admin(`select coalesce(user_status, '-') from public.recurring_streams where stream_key = '${key}'`);

test('undo of a removed subscription keeps what it was', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.recurring_streams (user_id, stream_key, merchant_key, currency, display_name, detected_status, user_status, source)
    values ('${A}', 'confirmed', 'confirmed', 'EUR', 'Gym', 'suggested', 'confirmed', 'bank'),
           ('${A}', 'undecided', 'undecided', 'EUR', 'Maybe', 'suggested', null, 'bank'),
           ('${A}', 'imported', 'imported', 'EUR', 'Old', null, 'confirmed', 'override')`);
  applySql(`supabase/migrations/${NAME}.sql`);

  await t.test('a confirmed suggestion comes back confirmed, even after two removes', () => {
    act('confirmed', 'dismiss');
    act('confirmed', 'dismiss');
    assert.strictEqual(status('confirmed'), 'dismissed');
    act('confirmed', 'undismiss');
    assert.strictEqual(status('confirmed'), 'confirmed');
  });

  await t.test('an undecided suggestion goes back to review; an imported one is confirmed', () => {
    act('undecided', 'dismiss');
    act('undecided', 'undismiss');
    assert.strictEqual(status('undecided'), '-');
    act('imported', 'dismiss');
    act('imported', 'undismiss');
    assert.strictEqual(status('imported'), 'confirmed');
  });

  await t.test('the other actions still work with the empty search_path', () => {
    as(`select public.stream_action((select id from public.recurring_streams where stream_key = 'undecided'), 'set_cadence', '{"cadence":"yearly"}')`);
    assert.strictEqual(admin(`select user_status || ' ' || user_cadence from public.recurring_streams where stream_key = 'undecided'`), 'confirmed yearly');
    admin(`update public.recurring_streams set user_status = null, user_cadence = null where stream_key = 'undecided'`);
  });

  await t.test('a remembered status is used once', () => {
    act('confirmed', 'dismiss');
    act('confirmed', 'undismiss');
    assert.strictEqual(admin(`select coalesce(prev_user_status, '-') from public.recurring_streams where stream_key = 'confirmed'`), '-');
  });

  await t.test('still security definer with an empty search_path, safe to re-run', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(admin(`select prosecdef || ' ' || array_to_string(proconfig, ',') from pg_proc where proname = 'stream_action'`), 'true search_path=""');
    assert.strictEqual(admin(`select has_function_privilege('anon', 'public.stream_action(uuid, text, jsonb)', 'execute')`), 'f');
  });

  await t.test('rollback restores the old function and drops the column', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(admin(`select count(*) from pg_attribute where attrelid = 'public.recurring_streams'::regclass and attname = 'prev_user_status'`), '0');
    act('undecided', 'dismiss');
    act('undecided', 'undismiss');
    assert.strictEqual(status('undecided'), '-');
  });
});
