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
const counted = (sid, ref) => sql(`select round(coalesce((select coalesce(personal_amount, amount) from public.transactions where entry_reference = '${ref}'), 0)
  + coalesce((select sum(e.amount) from public.v_splitwise_eur e join public.splitwise_expenses s using (id) where s.splitwise_id = ${sid}), 0), 2)`);

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

  await t.test('#20: an expense I paid all for others (my share 0) frees the bank payment when it goes', () => {
    pay('p20-del', 40); pay('p20-dis', 40); pay('p20-chg', 40);
    apply({ reviews: [review(2001, { cost: '40', my_share: '0', my_paid: '40' }), review(2002, { cost: '40', my_share: '0', my_paid: '40' }),
      review(2003, { cost: '40', my_share: '0', my_paid: '40' })] });
    link(2001, 'p20-del'); link(2002, 'p20-dis'); link(2003, 'p20-chg');
    assert.strictEqual(tx('p20-del'), '0.00|-|-', 'linked: none of it is my spending');
    apply({ deleted: [2001] });
    assert.strictEqual(tx('p20-del'), '-|-|-', 'deleted in Splitwise: the payment counts again');
    owner(`select public.dismiss_splitwise_review('${reviewId(2002)}')`);
    assert.strictEqual(tx('p20-dis'), '-|-|-', 'dismissed: freed');
    apply({ reviews: [review(2003, { cost: '40', my_share: '10', my_paid: '40' })] });
    assert.strictEqual(tx('p20-chg'), '-|-|-', 'amounts changed: freed, and asked again');
    link(2003, 'p20-chg');
    assert.strictEqual(tx('p20-chg'), '10.00|-|-', 'and it can be linked again');
  });

  await t.test('#1: several payers, I paid less than my share: my whole share counts, and undoes cleanly', () => {
    // Dinner 100, I paid 30 of it, my share is 50.
    pay('p1-30', 30);
    apply({ reviews: [review(101, { kind: 'multi_payer', cost: '100', my_share: '50', my_paid: '30' })] });
    link(101, 'p1-30');
    assert.strictEqual(counted(101, 'p1-30'), '50.00', 'the payment in full plus the 20 I still owe');
    assert.strictEqual(tx('p1-30'), '30|-|-', 'the payment counts in full');
    assert.match(link(101, 'p1-30'), /already settled/);
    apply({ deleted: [101] });
    assert.strictEqual(tx('p1-30'), '-|-|-', 'deleted in Splitwise: payment freed');
    assert.strictEqual(sql('select count(*) from public.splitwise_expenses where splitwise_id = 101'), '0');
    // Paid exactly my share: the payment is all mine, no extra share.
    pay('p1-50', 50);
    apply({ reviews: [review(102, { kind: 'multi_payer', cost: '100', my_share: '50', my_paid: '50' })] });
    link(102, 'p1-50');
    assert.strictEqual(counted(102, 'p1-50'), '50.00');
  });

  await t.test('#2: a CSV import after connecting skips the shares the sync already has', () => {
    apply({ shares: [share(201, { booking_date: '2026-11-10', description: 'Pizza', amount: '15.00' })] });
    const csv = (fingerprint, date, description, amount = 15) =>
      ({ fingerprint, booking_date: date, description, category: null, amount, currency: 'EUR', linked_account_uid: null, linked_entry_reference: null });
    const out = owner(`select public.import_splitwise(gen_random_uuid(), 'Flat', '2026-11-09', '2026-11-13', ${lit([
      csv('c2-a', '2026-11-11', ' PIZZA '), // the synced one, a day off: skipped
      csv('c2-b', '2026-11-12', 'Pizza'), // two days off: another expense
      csv('c2-c', '2026-11-10', 'Beer', 6), // not synced: imported
    ])}, '[]')`);
    assert.match(out, /"shares": 2/);
    assert.strictEqual(sql(`select string_agg(coalesce(splitwise_id::text, fingerprint), ',' order by booking_date, fingerprint)
      from public.splitwise_expenses where description ilike '%pizza%' or description = 'Beer'`), 'c2-c,201,c2-b');
    apply({ shares: [share(201, { booking_date: '2026-11-10', description: 'Pizza', amount: '15.00' })] });
    assert.strictEqual(sql(`select count(*) from public.splitwise_expenses where lower(btrim(description)) = 'pizza' and booking_date <= '2026-11-11'`), '1');
  });

  await t.test('#3: undoing a CSV import keeps the rows (and links) the sync adopted', () => {
    const B3 = '33333333-0000-0000-0000-000000000003';
    pay('p3-paid', 90, '2026-10-20');
    sql(`update public.transactions set personal_amount = 30, import_batch_id = '${B3}' where entry_reference = 'p3-paid';
      insert into public.splitwise_expenses (user_id, group_name, fingerprint, booking_date, description, amount, currency, batch_id, linked_account_uid, linked_entry_reference)
      values ('${A}', 'Trip', 'c3-taxi', '2026-10-12', 'Taxi', 8, 'EUR', '${B3}', null, null),
             ('${A}', 'Trip', 'c3-train', '2026-10-20', 'Train', 30, 'EUR', '${B3}', '${ACC}', 'p3-paid'),
             ('${A}', 'Trip', 'c3-only', '2026-10-13', 'Museum', 5, 'EUR', '${B3}', null, null)`);
    assert.deepStrictEqual(apply({ shares: [share(301, { group_name: 'Trip', booking_date: '2026-10-12', description: 'Taxi', amount: '8.00' })],
      reviews: [review(302, { group_name: 'Trip', booking_date: '2026-10-20', description: 'Train', cost: '90', my_share: '30', my_paid: '90' })] }),
    { new: 0, adopted: 2, review: 0, deleted: 0 });
    assert.deepStrictEqual(JSON.parse(owner(`select public.undo_splitwise_import('${B3}')`)), { shares: 1, links: 0 });
    assert.strictEqual(sql(`select string_agg(coalesce(splitwise_id::text, fingerprint), ',' order by fingerprint) from public.splitwise_expenses where group_name = 'Trip'`), '301,302');
    assert.strictEqual(tx('p3-paid'), '30|-|-', 'the adopted link still counts my share only');
    assert.strictEqual(sql('select status || linked_entry_reference from public.splitwise_review where splitwise_id = 302'), 'linkedp3-paid');
  });

  // ---- rollback (keep last) ----
  await t.test('the rollback brings back the functions this migration redefines', () => {
    // Not covered by this pass (logged as a new finding): the rollback's old primary key can't take
    // a CSV balance saved in two currencies after the migration (the audit-gap case above).
    sql(`delete from public.splitwise_balances where group_name = 'Legacy' and currency = 'USD'`);
    applySql(DOWN);
    const def = (fn) => sql(`select pg_get_functiondef('public.${fn}'::regproc)`);
    assert.doesNotMatch(def('undo_splitwise_import'), /splitwise_id/, '20261116000000 version');
    applySql(UP);
    assert.match(def('undo_splitwise_import'), /splitwise_id is null/);
  });
});
