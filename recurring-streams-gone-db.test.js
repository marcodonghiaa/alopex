// Streams the detector no longer finds (20261218000000_recurring_streams_gone), run for real against
// Postgres on the full schema: a stream you confirmed or dismissed is kept but marked 'gone' when a run
// no longer finds it (say its charge was marked One-time), so the Subscriptions page can hide it; it
// comes back with your choices when a run finds it again. Needs psql and RLS_TEST_DATABASE_URL (a
// superuser URL to a throwaway server); skipped without it. A fresh database is created and dropped per run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const db = `recurring_gone_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const NAME = '20261218000000_recurring_streams_gone';
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
const row = (key, name = 'Plan') => ({
  stream_key: key, merchant_key: key, account_uid: null, currency: 'EUR', display_name: name, category: 'Services',
  cadence: 'monthly', typical_amount: 3, typical_amount_eur: 3, charge_count: 3, first_charged: '2026-08-20',
  last_charged: '2026-10-20', next_expected: '2026-11-20', detected_status: 'active', is_direct_debit: false,
});
const upsert = (rows) => sql(`select public.upsert_detected_streams('${A}', '${JSON.stringify(rows)}'::jsonb)`);
const streams = () => sql(`select stream_key || ':' || coalesce(detected_status, '-') || ':' || coalesce(user_status, '-')
  || ':' || coalesce(user_cadence, '-') || ':' || coalesce(display_name, '-')
  from public.recurring_streams where user_id = '${A}' order by stream_key`).split('\n').filter(Boolean);

test('streams no longer detected, on a real Postgres', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  sql(`insert into auth.users (id) values ('${A}')`);
  applySql(UP);

  upsert([row('confirmed'), row('dismissed'), row('undecided')]);
  sql(`update public.recurring_streams set user_status = 'confirmed', user_cadence = 'monthly' where stream_key = 'confirmed';
    update public.recurring_streams set user_status = 'dismissed' where stream_key = 'dismissed';
    insert into public.recurring_streams (user_id, stream_key, merchant_key, currency, display_name, user_status, source)
      values ('${A}', 'imported', 'imported', 'EUR', 'Old', 'confirmed', 'override')`);

  // protects=marking a confirmed subscription's charge One-time hides it; fails_when=only undecided rows are cleaned
  await t.test('a run that finds nothing marks your decided streams gone, keeps your choices, drops undecided', () => {
    upsert([]);
    assert.deepStrictEqual(streams(), [
      'confirmed:gone:confirmed:monthly:Plan',
      'dismissed:gone:dismissed:-:Plan',
      'imported:-:confirmed:-:Old', // never detected: an imported override stays as it was
    ]);
  });

  await t.test('found again: back to its detected status with your choices and the new name', () => {
    upsert([row('confirmed', 'iCloud')]);
    assert.strictEqual(streams()[0], 'confirmed:active:confirmed:monthly:iCloud');
  });

  // Polish 1 #12: the old version ran inside begin…rollback, so it passed even when the write worked.
  await t.test('users still cannot write gone themselves', () => {
    let err = '';
    try {
      execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1'], {
        input: `set role authenticated; set request.jwt.claims = '{"sub":"${A}"}';
          update public.recurring_streams set detected_status = 'gone';`,
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      err = String(e.stderr);
    }
    assert.match(err, /permission denied/);
    assert.strictEqual(streams()[0], 'confirmed:active:confirmed:monthly:iCloud');
  });

  await t.test('rolls back (gone rows show again, as before) and applies again', () => {
    upsert([]);
    applySql(DOWN);
    assert.strictEqual(streams()[0], 'confirmed:suggested:confirmed:monthly:iCloud');
    assert.match(sql(`update public.recurring_streams set detected_status = 'gone'`), /check constraint/);
    applySql(UP);
    upsert([]);
    assert.strictEqual(streams()[0], 'confirmed:gone:confirmed:monthly:iCloud');
  });
});
