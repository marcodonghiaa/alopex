// Polish pass 1 of the Splitwise API sync (20261213000000_splitwise_api_sync), on a real Postgres
// with the full schema: each case is a bug the review found, or an old write path run against a
// row stored before the migration. Same setup as splitwise-api-sync-db.test.js. Needs psql and
// RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server); skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACC = 'aaaaaaaa-1111-0000-0000-000000000001';
const db = `splitwise_polish_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const NAME = '20261213000000_splitwise_api_sync';
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
// As `role` (and user `sub`), committed. Returns the output, or the error text.
function run(role, sub, q) {
  try {
    return execFileSync('psql', [dbUrl(), '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], {
      input: `begin; set local role ${role}; ${sub ? `set local request.jwt.claims = '{"sub":"${sub}"}';` : ''} ${q}; commit;`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return `ERROR ${String(e.stderr)}`;
  }
}
const owner = (q) => run('authenticated', A, q);
const lit = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

const share = (id, over = {}) => ({
  splitwise_id: id, group_name: 'Flat', booking_date: '2026-11-02', description: `Dinner ${id}`, category: null,
  amount: '12.34', currency: 'EUR', splitwise_updated_at: '2026-11-02T10:00:00Z', ...over,
});
const review = (id, over = {}) => ({
  splitwise_id: id, kind: 'paid_by_me', group_name: 'Flat', booking_date: '2026-11-03', description: `Groceries ${id}`,
  cost: '60.00', my_share: '20.00', my_paid: '60.00', currency: 'EUR', splitwise_updated_at: '2026-11-03T10:00:00Z', ...over,
});
function apply({ shares = [], reviews = [], deleted = [], balances = null } = {}) {
  const out = run('service_role', null, `select public.splitwise_sync_apply('${A}', ${lit(shares)}, ${lit(reviews)},
    array[${deleted.join(',')}]::bigint[], ${balances === null ? 'null' : lit(balances)}, null, false, false)`);
  return out.startsWith('ERROR') ? out : JSON.parse(out);
}
const reviewId = (sid) => sql(`select id from public.splitwise_review where splitwise_id = ${sid}`);
const link = (sid, ref) => owner(`select public.link_splitwise_review('${reviewId(sid)}', '${ACC}', '${ref}')`);
// A bank payment of mine: amount, debit or credit, date.
const pay = (ref, amount, date = '2026-11-03', dir = 'DBIT') =>
  sql(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date)
       values ('${ref}', '${ACC}', '${A}', ${amount}, 'EUR', '${dir}', '${date}')`);
const tx = (ref) => sql(`select coalesce(personal_amount::text, '-') || '|' || coalesce(flow_type, '-') || '|' || coalesce(flow_source, '-')
  from public.transactions where entry_reference = '${ref}'`);
// What the spending views count for one Splitwise expense: the bank payment's personal amount
// (or all of it), plus its shares not linked to a bank payment (v_splitwise_eur).
const counted = (sid, ref) => sql(`select coalesce((select coalesce(personal_amount, amount) from public.transactions where entry_reference = '${ref}'), 0)
  + coalesce((select sum(amount) from public.v_splitwise_eur e join public.splitwise_expenses s using (id) where s.splitwise_id = ${sid}), 0)`);

test('Splitwise API sync, polish pass 1, on a real Postgres', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db} encoding 'UTF8' template template0`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  // Stored before the migration: balances from a CSV import (primary key without currency).
  sql(`insert into auth.users (id) values ('${A}');
    insert into public.accounts (uid, user_id, currency, label) values ('${ACC}', '${A}', 'EUR', 'Card');
    insert into public.splitwise_balances (user_id, group_name, person, balance, currency, is_me, basis)
    values ('${A}', 'Legacy', 'Ann', 12.5, 'EUR', true, 'pairwise'), ('${A}', 'Legacy', 'Bo', -12.5, 'EUR', false, 'pairwise');`);
  applySql(UP);
  sql(`select public.splitwise_save_connection('${A}', 'key-one', 111, 'Ann')`);

  await t.test('audit gap: save_splitwise_balances replaces balances stored before the migration', () => {
    const out = owner(`select public.save_splitwise_balances('Legacy', ${lit([
      { person: 'Ann', balance: 20, currency: 'EUR', is_me: true, basis: 'pairwise' },
      { person: 'Ann', balance: -3, currency: 'USD', is_me: true, basis: 'pairwise' },
      { person: 'Bo', balance: -20, currency: 'EUR', is_me: false, basis: 'pairwise' },
    ])})`);
    assert.deepStrictEqual(JSON.parse(out), { balances: 3 });
    assert.strictEqual(sql(`select string_agg(person || balance || currency, ',' order by person, currency)
      from public.splitwise_balances where group_name = 'Legacy'`), 'Ann20EUR,Ann-3USD,Bo-20EUR');
  });
});
