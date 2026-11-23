// Switching Splitwise accounts (20270102000000_splitwise_switch_account, H062): connecting a
// different Splitwise account used to keep the old account's shares in spending, because the
// next full check held the removal back every week. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a
// throwaway server); skipped without it. A fresh database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACC = 'aaaaaaaa-1111-0000-0000-000000000001';
const db = `splitwise_switch_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const NAME = '20270102000000_splitwise_switch_account';
const UP = `supabase/migrations/${NAME}.sql`;
const DOWN = `supabase/rollbacks/${NAME}.down.sql`;
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();

function psql(target, args) {
  return execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const sql = (q) => psql(dbUrl(), ['-c', q]);
const applySql = (file) =>
  execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
    input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const claims = (sub) => (sub ? `set local request.jwt.claims = '{"sub":"${sub}"}';` : '');
// As `role` (and user `sub`), committed. Returns the output, or the error text.
// On stdin: a 5001-row batch is too long for a command line.
function run(role, sub, q, keep = true) {
  try {
    return execFileSync('psql', [dbUrl(), '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], {
      input: `begin; set local role ${role}; ${claims(sub)} ${q}; ${keep ? 'commit' : 'rollback'};`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return `ERROR ${String(e.stderr)}`;
  }
}
const as = (role, sub, q) => run(role, sub, q, false);
const lit = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

const share = (id, over = {}) => ({
  splitwise_id: id, group_name: 'Flat', booking_date: '2026-11-02', description: `Dinner ${id}`, category: null,
  amount: '12.34', currency: 'EUR', splitwise_updated_at: '2026-11-02T10:00:00Z', ...over,
});
const review = (id, over = {}) => ({
  splitwise_id: id, kind: 'paid_by_me', group_name: 'Flat', booking_date: '2026-11-03', description: `Groceries ${id}`,
  cost: '60.00', my_share: '20.00', my_paid: '60.00', currency: 'EUR', splitwise_updated_at: '2026-11-03T10:00:00Z', ...over,
});
// One sync write as the service role. Returns the counts, or the error text.
function apply({ user = A, shares = [], reviews = [], deleted = [], balances = null, cursor = null, full = false, preview = false } = {}) {
  const out = run('service_role', null, `select public.splitwise_sync_apply('${user}', ${lit(shares)}, ${lit(reviews)},
    array[${deleted.join(',')}]::bigint[], ${balances === null ? 'null' : lit(balances)},
    ${cursor ? `'${cursor}'` : 'null'}, ${full}, ${preview})`);
  return out.startsWith('ERROR') ? out : JSON.parse(out);
}
const reviewId = (sid) => sql(`select id from public.splitwise_review where splitwise_id = ${sid}`);
const tx = (ref) => sql(`select coalesce(personal_amount::text, '-') || '|' || coalesce(flow_type, '-') || '|' || coalesce(flow_source, '-')
  from public.transactions where entry_reference = '${ref}'`);

const count = (q) => sql(`select count(*) from public.${q}`);

test('switching Splitwise accounts on a real Postgres', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  sql(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.accounts (uid, user_id, currency, label) values ('${ACC}', '${A}', 'EUR', 'Card');
    insert into public.splitwise_expenses (user_id, group_name, fingerprint, booking_date, description, amount, currency, batch_id)
    values ('${A}', 'Flat', 'csv-1', '2026-11-01', 'Pizza night', 15.5, 'EUR', gen_random_uuid());`);
  applySql(UP);
  applySql(UP); // twice: safe to re-run

  sql(`select public.splitwise_save_connection('${A}', 'key-one', 111, 'Ann Example')`);
  assert.deepStrictEqual(apply({ shares: [share(1), share(2)], reviews: [review(10)], full: true }), { new: 2, adopted: 0, review: 1, deleted: 0 });

  await t.test('the same account again keeps every synced share', () => {
    sql(`select public.splitwise_save_connection('${A}', 'key-two', 111, 'Ann Example')`);
    assert.strictEqual(count(`splitwise_expenses where source = 'api'`), '2');
    assert.strictEqual(count('splitwise_review'), '1');
  });

  await t.test("another account drops the old account's synced shares and review rows, keeps CSV rows", () => {
    sql(`select public.splitwise_save_connection('${A}', 'key-three', 222, 'Ann Other')`);
    assert.strictEqual(count(`splitwise_expenses where source = 'api'`), '0');
    assert.strictEqual(count('splitwise_review'), '0');
    assert.strictEqual(count(`splitwise_expenses where fingerprint = 'csv-1'`), '1');
    assert.strictEqual(sql(`select splitwise_user_id || ':' || status || ':' || (cursor_updated_at is null) from public.splitwise_connections`), '222:ok:true');
    assert.strictEqual(as('service_role', null, `select public.splitwise_read_key('${A}')`), 'key-three');
    assert.strictEqual(sql(`select count(*) from vault.secrets where name like 'splitwise_api_key:%'`), '1');
  });

  await t.test('rolls back to the previous definition', () => {
    applySql(DOWN);
    assert.strictEqual(sql(`select count(*) from pg_proc where proname = 'splitwise_save_connection'`), '1');
  });
});
