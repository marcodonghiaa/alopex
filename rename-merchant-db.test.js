// rename_merchant "only this one" and Apple/PayPal/Google aliases by price
// (20261226000000_rename_one_or_by_price) on a real Postgres with every migration before it.
// Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server); skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const MIGRATION = 'supabase/migrations/20261226000000_rename_one_or_by_price.sql';
const ROLLBACK = 'supabase/rollbacks/20261226000000_rename_one_or_by_price.down.sql';
const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACC_A = 'aaaaaaaa-1111-0000-0000-000000000001';
const ACC_B = 'bbbbbbbb-1111-0000-0000-000000000002';
const db = `rename_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);

function psql(target, args) {
  return execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const admin = (q) => psql(dbUrl(), ['-c', q]);
function as(sub, q) {
  const who = `set local role authenticated; set local request.jwt.claims = '{"sub":"${sub}","role":"authenticated"}';`;
  try {
    return psql(dbUrl(), ['-c', `begin; ${who} ${q}; commit;`]);
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
// A bank row as the sync writes it (the insert trigger picks up the alias).
const bankRow = (ref, user, acc, name, key, amount) =>
  admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, merchant_key)
    values ('${ref}', '${acc}', '${user}', ${amount}, 'EUR', 'DBIT', '2026-11-20', '${name}', ${key ? `'${key}'` : 'null'})`);
const name = (ref) => admin(`select coalesce(custom_name, '-') from public.transactions where entry_reference = '${ref}'`);
const names = (...refs) => refs.map(name).join(',');
const rename = (user, ref, newName, onlyThis) =>
  as(user, `select public.rename_merchant('${ref}', '${user === A ? ACC_A : ACC_B}', ${newName === null ? 'null' : `'${newName}'`}${onlyThis === undefined ? '' : `, ${onlyThis}`})`);

test('rename one transaction, or an Apple charge by price, on a real Postgres', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < MIGRATION.split('/').pop())) applySql(`supabase/migrations/${f}`);
  admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC_A}', '${A}', 'EUR'), ('${ACC_B}', '${B}', 'EUR');`);
  // Before: two Apple services (1.99 and 2.80) and Netflix; A named "Apple.com" iCloud the old way.
  bankRow('m1', A, ACC_A, 'Apple.com', 'apple', 1.99);
  bankRow('m2', A, ACC_A, 'Apple.com', 'apple', 1.99);
  bankRow('c1', A, ACC_A, 'Apple.com', 'apple', 2.8);
  bankRow('c2', A, ACC_A, 'Apple.com', 'apple', 2.8);
  bankRow('n1', A, ACC_A, 'NETFLIX.COM', 'netflix', 12.99);
  bankRow('n2', A, ACC_A, 'NETFLIX.COM', 'netflix', 12.99);
  bankRow('b1', B, ACC_B, 'Apple.com', 'apple', 1.99);
  assert.strictEqual(rename(A, 'c1', 'iCloud'), '4');
  assert.strictEqual(names('m1', 'm2', 'c1', 'c2'), 'iCloud,iCloud,iCloud,iCloud', 'the bug: one name for both services');

  applySql(MIGRATION);

  await t.test('renaming the 1.99 Apple charge leaves the 2.80 one alone', () => {
    assert.strictEqual(rename(A, 'm1', 'Apple Music'), '2');
    assert.strictEqual(names('m1', 'm2', 'c1', 'c2'), 'Apple Music,Apple Music,iCloud,iCloud');
    assert.strictEqual(name('b1'), '-', "B's row is not A's");
  });

  await t.test('future Apple charges take the name of their price, else the old name', () => {
    bankRow('m3', A, ACC_A, 'Apple.com', 'apple', 2.09); // a price rise within 10%
    bankRow('c3', A, ACC_A, 'Apple.com', 'apple', 2.8);
    bankRow('x1', A, ACC_A, 'Apple.com', 'apple', 9.99);
    assert.strictEqual(names('m3', 'c3', 'x1'), 'Apple Music,iCloud,iCloud');
  });

  await t.test('renaming the same price again replaces its alias', () => {
    assert.strictEqual(rename(A, 'm2', 'Music'), '3');
    assert.strictEqual(names('m1', 'm2', 'm3', 'c1'), 'Music,Music,Music,iCloud');
    assert.strictEqual(admin(`select count(*) from public.merchant_aliases where user_id = '${A}'`), '2');
  });

  await t.test('only this one renames just the clicked row and stores no alias', () => {
    assert.strictEqual(rename(A, 'n1', 'Netflix Kids', true), '1');
    assert.strictEqual(names('n1', 'n2'), 'Netflix Kids,-');
    bankRow('n3', A, ACC_A, 'NETFLIX.COM', 'netflix', 12.99);
    assert.strictEqual(name('n3'), '-');
    assert.strictEqual(rename(A, 'c1', 'Storage', true), '1');
    assert.strictEqual(names('c1', 'c2', 'c3'), 'Storage,iCloud,iCloud');
  });

  await t.test('a normal merchant still renames every row, for every price', () => {
    assert.strictEqual(rename(A, 'n2', 'Netflix', false), '2'); // n2, n3; n1 was named by hand
    assert.strictEqual(names('n1', 'n2', 'n3'), 'Netflix Kids,Netflix,Netflix');
    bankRow('n4', A, ACC_A, 'NETFLIX.COM', 'netflix', 17.99);
    assert.strictEqual(name('n4'), 'Netflix');
  });

  await t.test("clearing a price goes back to the bank's name at that price only", () => {
    assert.strictEqual(rename(A, 'm1', null), '3');
    assert.strictEqual(names('m1', 'm2', 'm3', 'c2'), '-,-,-,iCloud');
  });

  await t.test('another user cannot rename A through the function', () => {
    assert.strictEqual(as(B, `select public.rename_merchant('c2', '${ACC_A}', 'Hacked')`), '0');
    assert.strictEqual(name('c2'), 'iCloud');
  });

  await t.test('rollback restores the three-argument function', () => {
    applySql(ROLLBACK);
    assert.strictEqual(admin(`select count(*) from public.merchant_aliases where user_id = '${A}'`), '2');
    assert.strictEqual(rename(A, 'n2', 'NF'), '3');
    assert.match(rename(A, 'n2', 'NF', true), /ERROR/);
  });
});
