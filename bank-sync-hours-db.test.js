// The 4 daily syncs sit in waking hours and never exceed 4 a day (banks allow ~4 unattended reads).
// Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a scratch Postgres).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const db = `bank_sync_hours_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const NAME = '20261224000000_bank_sync_hours';
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const JOBS = ['sync-banks', 'post-sync', 'sync-prices', 'sync-splitwise', 'detect-recurring'];

const psql = (target, args) => execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const sql = (q) => psql(dbUrl(), ['-c', q]);
const applySql = (file) => execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
  input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
  stdio: ['pipe', 'pipe', 'pipe'],
});
const schedules = () => sql(`select string_agg(jobname || '=' || schedule, ',' order by jobname) from cron.job
  where jobname in (${JOBS.map((j) => `'${j}'`).join(',')})`);

test('bank sync hours migration', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  const before = schedules();
  assert.match(before, /sync-banks=17 \*\/6 \* \* \*/);

  await t.test('the whole chain moves to 05, 11, 16, 21 UTC, same minutes, same commands', () => {
    const commands = sql(`select string_agg(command, '|' order by jobname) from cron.job`);
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(schedules(), 'detect-recurring=47 5,11,16,21 * * *,post-sync=32 5,11,16,21 * * *,'
      + 'sync-banks=17 5,11,16,21 * * *,sync-prices=37 5,11,16,21 * * *,sync-splitwise=42 5,11,16,21 * * *');
    assert.strictEqual(sql(`select string_agg(command, '|' order by jobname) from cron.job`), commands);
  });

  await t.test('banks still sync at most 4 times a day', () => {
    const hours = sql(`select schedule from cron.job where jobname = 'sync-banks'`).split(' ')[1].split(',');
    assert.ok(hours.length <= 4, hours.join(','));
  });

  await t.test('re-running is safe: one job per name', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(sql(`select count(*) from cron.job where jobname in (${JOBS.map((j) => `'${j}'`).join(',')})`), '5');
  });

  await t.test('rolls back to every 6 hours', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(schedules(), before);
  });
});
