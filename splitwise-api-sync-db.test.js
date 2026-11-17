// Splitwise API sync (20261213000000_splitwise_api_sync), run for real against Postgres on the
// full schema: who can reach the connection and its key, what one sync run writes (shares,
// adopted CSV rows, the review list, balances), the owner's review actions and their undo, the
// disconnect, and the rollback. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a
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
const db = `splitwise_sync_${process.pid}`;
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

test('Splitwise API sync on a real Postgres', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  sql(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.accounts (uid, user_id, currency, label) values ('${ACC}', '${A}', 'EUR', 'Card');
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date)
    values ('pay-60', '${ACC}', '${A}', 60, 'EUR', 'DBIT', '2026-11-03'),
           ('pay-other', '${ACC}', '${A}', 60, 'EUR', 'DBIT', '2026-11-03'),
           ('settle-out', '${ACC}', '${A}', 25, 'EUR', 'DBIT', '2026-11-04'),
           ('settle-in', '${ACC}', '${A}', 25, 'EUR', 'CRDT', '2026-11-04');
    -- A share imported from the CSV before connecting, and an expense I paid it linked.
    insert into public.splitwise_expenses (user_id, group_name, fingerprint, booking_date, description, category, amount, currency, batch_id)
    values ('${A}', 'flat ', 'csv-1', '2026-11-01', 'Pizza night', 'Dine Out', 15.5, 'EUR', gen_random_uuid());
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, personal_amount, import_batch_id)
    values ('csv-paid', '${ACC}', '${A}', 90, 'EUR', 'DBIT', '2026-10-20', 30, gen_random_uuid());
    insert into public.splitwise_expenses (user_id, group_name, fingerprint, booking_date, description, amount, currency, batch_id, linked_account_uid, linked_entry_reference)
    values ('${A}', 'Flat', 'csv-2', '2026-10-20', 'Train tickets', 30, 'EUR', gen_random_uuid(), '${ACC}', 'csv-paid');`);
  applySql(UP);

  await t.test('signed-in users and visitors cannot reach connections, keys or the sync write', () => {
    for (const role of ['anon', 'authenticated']) {
      const sub = role === 'authenticated' ? A : null;
      assert.match(as(role, sub, 'select count(*) from public.splitwise_connections'), /permission denied/, role);
      for (const call of [
        `public.splitwise_sync_apply('${A}', '[]', '[]', '{}', null, null, false, false)`,
        `public.splitwise_sync_write('${A}', '[]', '[]', '{}', null, null, false)`,
        `public.splitwise_save_connection('${A}', 'k', 1, 'x')`,
        `public.splitwise_read_key('${A}')`,
        `public.splitwise_disconnect('${A}', true)`,
        `public.splitwise_csv_match('${A}', 'g', '2026-01-01', 'd', 1, 'EUR')`,
      ]) {
        assert.match(as(role, sub, `select ${call}`), /permission denied/, `${role}: ${call}`);
      }
    }
    assert.match(as('anon', null, 'select * from public.get_splitwise_connection()'), /permission denied/);
    assert.match(as('anon', null, 'select count(*) from public.splitwise_review'), /permission denied/);
    assert.match(as('authenticated', A, `insert into public.splitwise_review (user_id, splitwise_id, kind, group_name, booking_date, description, cost, my_share, my_paid, currency)
      values ('${A}', 1, 'paid_by_me', 'g', '2026-01-01', 'd', 1, 1, 1, 'EUR')`), /permission denied/);
  });

  await t.test('a sync needs a connection', () => {
    assert.match(apply({ shares: [share(1)] }), /Splitwise is not connected/);
  });

  await t.test('connecting stores the key in Vault only, and the owner sees no key', () => {
    sql(`select public.splitwise_save_connection('${A}', 'key-one', 111, 'Ann Example')`);
    assert.strictEqual(sql(`select count(*) from vault.secrets where secret = 'key-one'`), '1');
    assert.strictEqual(as('service_role', null, `select public.splitwise_read_key('${A}')`), 'key-one');
    assert.strictEqual(as('authenticated', A, 'select connected || status || display_name from public.get_splitwise_connection()'), 'trueokAnn Example');
    assert.strictEqual(as('authenticated', B, 'select connected::text || coalesce(status, \'-\') from public.get_splitwise_connection()'), 'false-');
    assert.doesNotMatch(as('authenticated', A, 'select row_to_json(c)::text from public.get_splitwise_connection() c'), /key/);
    // The same account again: one secret, replaced.
    sql(`update public.splitwise_connections set cursor_updated_at = '2026-11-01' where user_id = '${A}'`);
    sql(`select public.splitwise_save_connection('${A}', 'key-two', 111, 'Ann Example')`);
    assert.strictEqual(sql(`select count(*) || ':' || min(secret) from vault.secrets where name like 'splitwise_api_key:%'`), '1:key-two');
    assert.strictEqual(sql(`select cursor_updated_at is not null from public.splitwise_connections`), 't');
    // Another Splitwise account: the sync starts over.
    sql(`select public.splitwise_save_connection('${A}', 'key-two', 222, 'Ann Other')`);
    assert.strictEqual(sql(`select cursor_updated_at is null and splitwise_user_id = 222 from public.splitwise_connections`), 't');
  });

  await t.test('a preview counts and writes nothing', () => {
    const counts = apply({ shares: [share(1), share(2)], reviews: [review(10)], preview: true });
    assert.deepStrictEqual(counts, { new: 2, adopted: 0, review: 1, deleted: 0 });
    assert.strictEqual(sql(`select count(*) from public.splitwise_expenses where source = 'api'`), '0');
    assert.strictEqual(sql(`select count(*) from public.splitwise_review`), '0');
    assert.strictEqual(sql(`select last_synced_at is null from public.splitwise_connections`), 't');
  });

  await t.test('shares are written once, amounts exact, cursor and status kept', () => {
    sql(`update public.splitwise_connections set status = 'error', last_error = 'HTTP 500' where user_id = '${A}'`);
    assert.deepStrictEqual(apply({ shares: [share(1), share(2), share(2)], cursor: '2026-11-05T00:00:00Z', full: true }),
      { new: 2, adopted: 0, review: 0, deleted: 0 });
    assert.strictEqual(sql(`select string_agg(amount::text || ':' || fingerprint || ':' || batch_id::text, ',') is not null
      and bool_and(amount = 12.34) from public.splitwise_expenses where source = 'api'`), 't');
    assert.strictEqual(sql(`select status || ':' || (last_error is null) || ':' || cursor_updated_at::date || ':' || (last_full_check_at is not null)
      from public.splitwise_connections`), 'ok:true:2026-11-05:true');
    assert.deepStrictEqual(apply({ shares: [share(1)], cursor: '2026-11-01T00:00:00Z' }), { new: 0, adopted: 0, review: 0, deleted: 0 });
    assert.strictEqual(sql('select cursor_updated_at::date from public.splitwise_connections'), '2026-11-05', 'the cursor never goes back');
  });

  await t.test('an edit in Splitwise keeps the category and description you set', () => {
    run('authenticated', A, `update public.splitwise_expenses set category = 'Groceries', description = 'Mine' where splitwise_id = 1`);
    apply({ shares: [share(1, { amount: '20.01', description: 'Theirs', category: 'Others', booking_date: '2026-11-06' })] });
    assert.strictEqual(sql('select amount || category || description || booking_date from public.splitwise_expenses where splitwise_id = 1'),
      '20.01GroceriesMine2026-11-06');
  });

  await t.test('a share already imported from the CSV is adopted, not doubled', () => {
    const counts = apply({ shares: [share(3, { group_name: 'Flat', booking_date: '2026-11-02', description: ' pizza NIGHT', amount: '15.50' })] });
    assert.deepStrictEqual(counts, { new: 0, adopted: 1, review: 0, deleted: 0 });
    assert.strictEqual(sql(`select fingerprint || ':' || source || ':' || category from public.splitwise_expenses where splitwise_id = 3`), 'csv-1:api:Dine Out');
    assert.strictEqual(sql(`select count(*) from public.splitwise_expenses where description ilike '%pizza%'`), '1');
  });

  await t.test('an expense I paid that the CSV import linked is adopted as linked', () => {
    const counts = apply({ reviews: [review(20, { booking_date: '2026-10-21', description: 'Train tickets', cost: '90', my_share: '30', my_paid: '90' })] });
    assert.deepStrictEqual(counts, { new: 0, adopted: 1, review: 0, deleted: 0 });
    assert.strictEqual(sql('select status || linked_entry_reference from public.splitwise_review where splitwise_id = 20'), 'linkedcsv-paid');
  });

  await t.test('the review list: new rows pending, only the owner sees them', () => {
    assert.deepStrictEqual(apply({ reviews: [review(10), review(11, { kind: 'settle_out', cost: '25', my_share: '25', my_paid: '25' }),
      review(12, { kind: 'settle_in', cost: '25', my_share: '25', my_paid: '0' }), review(13)] }), { new: 0, adopted: 0, review: 4, deleted: 0 });
    assert.strictEqual(as('authenticated', A, `select count(*) from public.splitwise_review where status = 'pending'`), '4');
    assert.strictEqual(as('authenticated', B, 'select count(*) from public.splitwise_review'), '0');
    assert.strictEqual(as('authenticated', B, `update public.splitwise_review set status = 'dismissed' returning 1`), '');
    assert.match(as('authenticated', B, 'delete from public.splitwise_review returning 1'), /permission denied/);
    assert.match(as('authenticated', B, `select public.link_splitwise_review('${reviewId(10)}', '${ACC}', 'pay-60')`), /no longer on the list/);
    assert.match(as('authenticated', B, `select public.dismiss_splitwise_review('${reviewId(10)}')`), /no longer on the list/);
  });

  await t.test('linking an expense I paid makes the bank payment count my share only', () => {
    assert.match(run('authenticated', A, `select public.link_splitwise_review('${reviewId(10)}', '${ACC}', 'settle-in')`), /no longer be linked/);
    run('authenticated', A, `select public.link_splitwise_review('${reviewId(10)}', '${ACC}', 'pay-60')`);
    assert.strictEqual(tx('pay-60'), '20.00|-|-');
    assert.strictEqual(sql('select amount || linked_entry_reference from public.splitwise_expenses where splitwise_id = 10'), '20.00pay-60');
    assert.match(run('authenticated', A, `select public.link_splitwise_review('${reviewId(10)}', '${ACC}', 'pay-other')`), /already settled/);
    // The same amounts at the next sync: still linked.
    apply({ reviews: [review(10, { description: 'Renamed' })] });
    assert.strictEqual(sql('select status || description from public.splitwise_review where splitwise_id = 10'), 'linkedRenamed');
  });

  await t.test('a settle-up links to a transfer of the right direction', () => {
    assert.match(run('authenticated', A, `select public.link_splitwise_review('${reviewId(11)}', '${ACC}', 'settle-in')`), /no longer be linked/);
    run('authenticated', A, `select public.link_splitwise_review('${reviewId(11)}', '${ACC}', 'settle-out')`);
    assert.strictEqual(tx('settle-out'), '-|transfer|user');
    run('authenticated', A, `select public.link_splitwise_review('${reviewId(12)}', '${ACC}', 'settle-in')`);
    assert.strictEqual(tx('settle-in'), '-|transfer|user');
    assert.match(run('authenticated', A, `select public.count_splitwise_review('${reviewId(12)}')`), /Only an expense you paid/);
  });

  await t.test('a rejected match is never linked, and the reject is remembered once', () => {
    assert.strictEqual(JSON.parse(run('authenticated', A, `select public.reject_splitwise_match('${reviewId(13)}', 'pay-other')`)).rejected, 1);
    assert.strictEqual(JSON.parse(run('authenticated', A, `select public.reject_splitwise_match('${reviewId(13)}', 'pay-other')`)).rejected, 0);
    assert.match(run('authenticated', A, `select public.link_splitwise_review('${reviewId(13)}', '${ACC}', 'pay-other')`), /not this expense/);
    assert.match(as('authenticated', B, `select public.reject_splitwise_match('${reviewId(13)}', 'x')`), /no longer on the list/);
    assert.match(as('authenticated', A, `select public.reject_splitwise_match('${reviewId(13)}', '')`), /Missing bank transaction/);
  });

  await t.test('counting, dismissing, and a dismissed row staying dismissed', () => {
    run('authenticated', A, `select public.count_splitwise_review('${reviewId(13)}')`);
    assert.strictEqual(sql('select amount || coalesce(linked_entry_reference, \'-\') from public.splitwise_expenses where splitwise_id = 13'), '20.00-');
    run('authenticated', A, `select public.dismiss_splitwise_review('${reviewId(13)}')`);
    assert.strictEqual(sql('select count(*) from public.splitwise_expenses where splitwise_id = 13'), '0');
    apply({ reviews: [review(13)] });
    assert.strictEqual(sql('select status from public.splitwise_review where splitwise_id = 13'), 'dismissed');
    apply({ reviews: [review(13, { my_share: '21.00' })] });
    assert.strictEqual(sql('select status from public.splitwise_review where splitwise_id = 13'), 'pending', 'amounts changed: asks again');
  });

  await t.test('a linked expense whose amounts change is unlinked and asked again', () => {
    apply({ reviews: [review(10, { my_share: '30.00' })] });
    assert.strictEqual(tx('pay-60'), '-|-|-');
    assert.strictEqual(sql('select status || coalesce(linked_entry_reference, \'-\') from public.splitwise_review where splitwise_id = 10'), 'pending-');
    assert.strictEqual(sql('select count(*) from public.splitwise_expenses where splitwise_id = 10'), '0');
    run('authenticated', A, `select public.link_splitwise_review('${reviewId(10)}', '${ACC}', 'pay-60')`);
    assert.strictEqual(tx('pay-60'), '30.00|-|-');
  });

  await t.test('an expense that becomes a share (or a review item) moves over', () => {
    apply({ shares: [share(10, { amount: '30.00' })] });
    assert.strictEqual(tx('pay-60'), '-|-|-', 'link freed');
    assert.strictEqual(sql('select count(*) from public.splitwise_review where splitwise_id = 10'), '0');
    assert.strictEqual(sql('select linked_entry_reference is null from public.splitwise_expenses where splitwise_id = 10'), 't');
    apply({ reviews: [review(2)] });
    assert.strictEqual(sql('select count(*) from public.splitwise_expenses where splitwise_id = 2'), '0');
    assert.strictEqual(sql('select status from public.splitwise_review where splitwise_id = 2'), 'pending');
  });

  await t.test('deleted in Splitwise: shares, review rows and links go', () => {
    assert.deepStrictEqual(apply({ deleted: [11, 12, 20, 999] }), { new: 0, adopted: 0, review: 0, deleted: 3 });
    assert.strictEqual(tx('settle-out'), '-|-|-');
    assert.strictEqual(tx('settle-in'), '-|-|-');
    assert.strictEqual(tx('csv-paid'), '-|-|-', 'the adopted CSV link is freed too');
    assert.strictEqual(sql('select count(*) from public.splitwise_review where splitwise_id in (11, 12, 20)'), '0');
  });

  await t.test('balances: one row per currency, replaced by each sync, CSV ones of the group too', () => {
    sql(`insert into public.splitwise_balances (user_id, group_name, person, balance, currency, is_me, basis)
      values ('${A}', 'Flat', 'Bo', 3, 'EUR', false, 'pairwise'), ('${A}', 'Trip', 'Cy', 4, 'EUR', false, 'pairwise')`);
    apply({ balances: [
      { group_name: 'Flat', person: 'Ann', balance: '10.00', currency: 'EUR', is_me: true },
      { group_name: 'Flat', person: 'Ann', balance: '-5.50', currency: 'USD', is_me: true },
      { group_name: 'Flat', person: 'Bo', balance: '-10.00', currency: 'EUR', is_me: false },
      { group_name: 'Flat', person: 'Bo', balance: '5.50', currency: 'USD', is_me: false },
    ] });
    assert.strictEqual(sql(`select string_agg(group_name || person || balance || currency || basis, ',' order by group_name, person, currency)
      from public.splitwise_balances`), 'FlatAnn10.00EURapi,FlatAnn-5.50USDapi,FlatBo-10.00EURapi,FlatBo5.50USDapi,TripCy4EURpairwise');
    apply({ balances: [] });
    assert.strictEqual(sql('select count(*) from public.splitwise_balances'), '1');
    apply({ balances: null });
    assert.strictEqual(sql('select count(*) from public.splitwise_balances'), '1');
  });

  await t.test('a CSV re-import of the group leaves synced rows alone', () => {
    run('authenticated', A, `select public.import_splitwise(gen_random_uuid(), 'Flat', '2026-01-01', '2026-12-31', '[]', '[]')`);
    assert.strictEqual(sql(`select count(*) > 0 from public.splitwise_expenses where group_name = 'Flat' and splitwise_id is not null`), 't');
  });

  await t.test('too many rows at once is refused', () => {
    const many = Array.from({ length: 5001 }, (_, i) => share(100000 + i));
    assert.match(apply({ shares: many }), /Too many rows/);
  });

  await t.test('disconnect: key gone; with deleteData, what the sync brought in goes too', () => {
    sql(`select public.splitwise_save_connection('${B}', 'key-b', 333, 'Bo')`);
    apply({ user: B, shares: [share(1)] });
    run('service_role', null, `select public.splitwise_disconnect('${B}', false)`);
    assert.strictEqual(sql(`select count(*) from public.splitwise_expenses where user_id = '${B}'`), '1', 'data kept');
    assert.strictEqual(sql(`select count(*) from vault.secrets where secret = 'key-b'`), '0');
    const out = JSON.parse(run('service_role', null, `select public.splitwise_disconnect('${A}', true)`));
    assert.ok(out.deleted >= 3);
    assert.strictEqual(sql(`select count(*) from public.splitwise_expenses where user_id = '${A}' and splitwise_id is not null`), '0');
    assert.strictEqual(sql(`select count(*) from public.splitwise_review where user_id = '${A}'`), '0');
    assert.strictEqual(sql(`select count(*) from public.splitwise_balances where user_id = '${A}' and basis = 'api'`), '0');
    assert.strictEqual(sql(`select count(*) from public.splitwise_connections`), '0');
    assert.strictEqual(sql(`select count(*) from vault.secrets where name like 'splitwise_api_key:%'`), '0');
  });

  await t.test('deleting the user deletes the connection and its key', () => {
    sql(`select public.splitwise_save_connection('${B}', 'key-b2', 333, 'Bo')`);
    sql(`delete from auth.users where id = '${B}'`);
    assert.strictEqual(sql(`select count(*) from public.splitwise_connections`), '0');
    assert.strictEqual(sql(`select count(*) from vault.secrets where secret = 'key-b2'`), '0');
  });

  await t.test('the sync is scheduled every 6 hours', () => {
    assert.strictEqual(sql(`select schedule || ' ' || command from cron.job where jobname = 'sync-splitwise'`),
      "42 */6 * * * select public.call_edge_function('sync-splitwise')");
  });

  await t.test('rolls back, and applies again', () => {
    sql(`select public.splitwise_save_connection('${A}', 'key-z', 111, 'Ann')`);
    applySql(DOWN);
    assert.strictEqual(sql(`select count(*) from vault.secrets where name like 'splitwise_api_key:%'`), '0');
    assert.strictEqual(sql(`select count(*) from cron.job where jobname = 'sync-splitwise'`), '0');
    assert.strictEqual(sql(`select to_regclass('public.splitwise_review') is null and to_regclass('public.splitwise_connections') is null`), 't');
    applySql(UP);
    assert.strictEqual(sql(`select count(*) from cron.job where jobname = 'sync-splitwise'`), '1');
  });
});
