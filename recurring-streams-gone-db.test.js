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

  // S1 (polish 2): the RPC took a 1,000,000-char name, charge_count -5, amount -1e15 and 5000 rows.
  // Lengths count characters (char_length), not bytes: each string ends in a 4-byte emoji after 2-byte é.
  await t.test('S1: each field is bounded, at the limit passes and one past is refused', () => {
    const chars = (n) => 'é'.repeat(n - 1) + '😀';
    const one = (key, patch) => upsert([{ ...row(key), ...patch }]);
    const limits = [
      ['stream_key', 1100, (s) => ({ stream_key: s })],
      ['merchant_key', 1000, (s) => ({ merchant_key: s })],
      ['display_name', 500, (s) => ({ display_name: s })],
      ['category', 100, (s) => ({ category: s })],
    ];
    for (const [field, n, patch] of limits) {
      assert.strictEqual(one(`s1-${field}`, patch(chars(n))), '1', `${field} at ${n}`);
      assert.match(one(`s1-${field}-past`, patch(chars(n + 1))), new RegExp(`${field} longer than ${n} characters`));
    }
    assert.strictEqual(one('s1-count0', { charge_count: 0 }), '1');
    assert.match(one('s1-count-neg', { charge_count: -5 }), /charge_count below 0/);
    for (const field of ['typical_amount', 'typical_amount_eur']) {
      assert.strictEqual(one(`s1-${field}-max`, { [field]: -999999999999.99 }), '1');
      for (const v of [1e12, -1e15, 'NaN', 'Infinity', '-Infinity']) {
        assert.match(one(`s1-${field}-bad`, { [field]: v }), new RegExp(`${field} is not a finite amount under 1e12`), `${field}=${v}`);
      }
    }
    assert.strictEqual(one('s1-eur-null', { typical_amount_eur: null }), '1');
    const many = (n) => sql(`select public.upsert_detected_streams('${A}', (select jsonb_agg(
      jsonb_build_object('stream_key', 's1-many-' || i, 'merchant_key', 'm', 'currency', 'EUR', 'charge_count', 1))
      from generate_series(1, ${n}) i))`);
    assert.strictEqual(many(2000), '2000');
    assert.match(many(2001), /2001 streams, at most 2000/);
    // Nothing from a refused call was written: the last good call left exactly its 2000 rows (undecided, so replaced).
    assert.strictEqual(sql(`select count(*) from public.recurring_streams where stream_key like 's1-%'`), '2000');
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
