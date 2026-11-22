// Category icon/colour and move_category (20261218000000_category_look_and_move) on a real Postgres
// with every migration before it: delete-and-move, rename, merges, built-ins, refusals and two users
// kept apart. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server); skipped
// without it. A fresh database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const MIGRATION = 'supabase/migrations/20261218000000_category_look_and_move.sql';
const ROLLBACK = 'supabase/rollbacks/20261218000000_category_look_and_move.down.sql';
const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACC_A = 'aaaaaaaa-1111-0000-0000-000000000001';
const ACC_B = 'bbbbbbbb-1111-0000-0000-000000000002';
const db = `catmove_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);

function psql(target, args) {
  return execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const admin = (q) => psql(dbUrl(), ['-c', q]);
// Runs q as signed-in user `sub` (or anon with no sub). Errors come back as text.
function as(sub, q, { keep = true } = {}) {
  const who = sub
    ? `set local role authenticated; set local request.jwt.claims = '{"sub":"${sub}","role":"authenticated"}';`
    : 'set local role anon;';
  try {
    return psql(dbUrl(), ['-c', `begin; ${who} ${q}; ${keep ? 'commit' : 'rollback'};`]);
  } catch (e) {
    return `ERROR ${String(e.stderr)}`;
  }
}
const applySql = (file) =>
  execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
    input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const cats = (user, table, col = 'category') =>
  admin(`select coalesce(string_agg(${col}, ',' order by ${col}), '') from public.${table} where user_id = '${user}'`);

test('category look and move on a real Postgres', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < MIGRATION.split('/').pop())) applySql(`supabase/migrations/${f}`);
  // Written before this migration: A has "Holiday" and "Trips" of their own, hid Taxes; B has "Holiday" too.
  admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC_A}', '${A}', 'EUR'), ('${ACC_B}', '${B}', 'EUR');
    insert into public.user_categories (user_id, name, hidden) values
      ('${A}', 'Holiday', false), ('${A}', 'Trips', false), ('${A}', 'Taxes', true), ('${B}', 'Holiday', false);`);
  applySql(MIGRATION);
  applySql(MIGRATION); // twice: safe to re-run

  const reset = () =>
    admin(`delete from public.transactions; delete from public.category_rules; delete from public.recurring_streams;
      delete from public.splitwise_expenses; delete from public.category_budgets; delete from public.spend_history;
      delete from public.user_categories;
      insert into public.user_categories (user_id, name, hidden, icon, color) values
        ('${A}', 'Holiday', false, 'holiday', 'cyan'), ('${A}', 'Trips', false, null, null),
        ('${A}', 'Taxes', true, null, null), ('${B}', 'Holiday', false, null, null);
      insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, category)
      values ('t1', '${ACC_A}', '${A}', 200, 'EUR', 'DBIT', '2026-11-10', 'Holiday'),
             ('t2', '${ACC_A}', '${A}', 80, 'EUR', 'DBIT', '2026-11-11', 'Holiday'),
             ('t3', '${ACC_A}', '${A}', 30, 'EUR', 'DBIT', '2026-11-12', 'Groceries'),
             ('tb', '${ACC_B}', '${B}', 50, 'EUR', 'DBIT', '2026-11-12', 'Holiday');
      insert into public.category_rules (user_id, match_field, match_text, set_category) values
        ('${A}', 'any', 'ryanair', 'Holiday'), ('${B}', 'any', 'ryanair', 'Holiday');
      insert into public.recurring_streams (user_id, stream_key, merchant_key, currency, category) values
        ('${A}', 's1', 'm1', 'EUR', 'Holiday'), ('${B}', 's1', 'm1', 'EUR', 'Holiday');
      insert into public.splitwise_expenses (user_id, group_name, fingerprint, booking_date, description, category, amount, currency, batch_id)
      values ('${A}', 'g', 'f1', '2026-11-01', 'Hotel', 'Holiday', 40, 'EUR', gen_random_uuid());
      insert into public.category_budgets (user_id, category, month, amount) values
        ('${A}', 'Holiday', '2026-11-01', 300), ('${A}', 'Holiday', '2026-12-01', 100), ('${A}', 'Trips', '2026-12-01', 50);
      insert into public.spend_history (user_id, month, category, spend_eur) values
        ('${A}', '2025-01-01', 'Holiday', 10), ('${A}', '2025-01-01', 'Trips', 5), ('${A}', '2025-02-01', 'Holiday', 7);`);

  await t.test('icon and colour: saved by the owner, names only', () => {
    reset();
    assert.strictEqual(as(A, "update public.user_categories set icon = 'flights', color = 'blue' where name = 'Trips' returning icon || ' ' || color"), 'flights blue');
    assert.match(as(A, "update public.user_categories set icon = '<svg onload=x>' where name = 'Trips'"), /check constraint/);
    assert.match(as(A, "update public.user_categories set color = '#ff0000' where name = 'Trips'"), /check constraint/);
    // A built-in can carry a look too.
    assert.strictEqual(as(A, "insert into public.user_categories (name, color) values ('Groceries', 'green') returning color"), 'green');
    assert.strictEqual(as(B, "select count(*) from public.user_categories where name = 'Trips'"), '0');
  });

  await t.test('delete and move: everything follows, nothing is left on the old name', () => {
    reset();
    assert.strictEqual(as(A, "select public.move_category('Holiday', 'Trips')"), '2');
    assert.strictEqual(cats(A, 'transactions'), 'Groceries,Trips,Trips');
    assert.strictEqual(cats(A, 'category_rules', 'set_category'), 'Trips');
    assert.strictEqual(cats(A, 'recurring_streams'), 'Trips');
    assert.strictEqual(cats(A, 'splitwise_expenses'), 'Trips');
    // Budgets: November moves over; December keeps the 50 Trips already had.
    assert.strictEqual(admin(`select string_agg(category || ' ' || month || ' ' || amount, ',' order by month) from public.category_budgets where user_id = '${A}'`), 'Trips 2026-11-01 300.00,Trips 2026-12-01 50.00');
    // Spend history adds up.
    assert.strictEqual(admin(`select string_agg(month || ' ' || spend_eur, ',' order by month) from public.spend_history where user_id = '${A}'`), '2025-01-01 15,2025-02-01 7');
    assert.strictEqual(cats(A, 'user_categories', 'name'), 'Taxes,Trips');
    // B's "Holiday" is untouched.
    assert.strictEqual(cats(B, 'transactions'), 'Holiday');
    assert.strictEqual(cats(B, 'category_rules', 'set_category'), 'Holiday');
    assert.strictEqual(cats(B, 'user_categories', 'name'), 'Holiday');
  });

  await t.test('move to a built-in category, matched without case', () => {
    reset();
    assert.strictEqual(as(A, "select public.move_category('Holiday', '  experiences ')"), '2');
    assert.strictEqual(cats(A, 'transactions'), 'Experiences,Experiences,Groceries');
    assert.strictEqual(cats(A, 'user_categories', 'name'), 'Taxes,Trips');
  });

  await t.test('rename: a new name is created with the same icon and colour', () => {
    reset();
    assert.strictEqual(as(A, "select public.move_category('Holiday', 'Travel  abroad')"), '2');
    assert.strictEqual(cats(A, 'transactions'), 'Groceries,Travel abroad,Travel abroad');
    assert.strictEqual(admin(`select icon || ' ' || color from public.user_categories where user_id = '${A}' and name = 'Travel abroad'`), 'holiday cyan');
    assert.strictEqual(cats(A, 'user_categories', 'name'), 'Taxes,Travel abroad,Trips');
    // Only the case changes: still a rename.
    assert.strictEqual(as(A, "select public.move_category('Travel abroad', 'TRAVEL ABROAD')"), '2');
    assert.strictEqual(cats(A, 'user_categories', 'name'), 'TRAVEL ABROAD,Taxes,Trips');
  });

  await t.test('rename a built-in: it is hidden and the new one keeps its default look', () => {
    reset();
    assert.strictEqual(as(A, "select public.move_category('Groceries', 'Food')"), '1');
    assert.strictEqual(cats(A, 'transactions'), 'Food,Holiday,Holiday');
    assert.strictEqual(admin(`select icon || ' ' || color from public.user_categories where user_id = '${A}' and name = 'Food'`), 'groceries indigo');
    assert.strictEqual(admin(`select hidden from public.user_categories where user_id = '${A}' and name = 'Groceries'`), 't');
    assert.strictEqual(as(A, "select public.move_category('Dine Out', 'Restaurants') is not null"), 't');
    assert.strictEqual(admin(`select icon from public.user_categories where user_id = '${A}' and name = 'Restaurants'`), 'dine-out');
  });

  await t.test('refusals change nothing', () => {
    reset();
    const before = cats(A, 'transactions');
    for (const [from, to, msg] of [
      ['Holiday', 'Holiday', /different category/],
      ['Holiday', '   ', /Pick the category/],
      ['Holiday', null, /Pick the category/],
      ['Holiday', 'x'.repeat(41), /At most 40/],
      ['Holiday', 'Taxes', /hidden/],
      ['Transfer', 'Others', /Transfer and Income/],
      ['Income', 'Others', /Transfer and Income/],
      ['Nope', 'Others', /not one of your categories/],
    ]) {
      const arg = to === null ? 'null' : `'${to}'`;
      assert.match(as(A, `select public.move_category('${from}', ${arg})`), msg, `${from} -> ${to}`);
    }
    assert.strictEqual(cats(A, 'transactions'), before);
    assert.strictEqual(cats(A, 'user_categories', 'name'), 'Holiday,Taxes,Trips');
  });

  await t.test("signed out can't call it; B's call only touches B", () => {
    reset();
    assert.match(as(null, "select public.move_category('Holiday', 'Trips')"), /permission denied/);
    assert.strictEqual(as(B, "select public.move_category('Holiday', 'Others')"), '1');
    assert.strictEqual(cats(A, 'transactions'), 'Groceries,Holiday,Holiday');
    assert.strictEqual(cats(B, 'transactions'), 'Others');
  });

  await t.test('rollback removes the function and the columns; categories stay', () => {
    reset();
    applySql(ROLLBACK);
    assert.strictEqual(admin("select count(*) from pg_proc where proname = 'move_category'"), '0');
    assert.strictEqual(admin("select count(*) from information_schema.columns where table_name = 'user_categories' and column_name in ('icon', 'color')"), '0');
    assert.strictEqual(cats(A, 'user_categories', 'name'), 'Holiday,Taxes,Trips');
    applySql(MIGRATION); // and forward again
    assert.strictEqual(admin("select count(*) from pg_proc where proname = 'move_category'"), '1');
  });
});
