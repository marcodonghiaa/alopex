// H079: the merchant alias is chosen in SQL only (20270112000000_merchant_alias_on_key_update): the
// alias trigger also runs when a row's merchant_key is set later, so the post-sync backfill writes
// merchant_key alone and its rows get the same alias the old TS lookup picked (exact name first,
// else the newest price-less alias for the key, never by key for PayPal, Apple or Google).
// Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270112000000_merchant_alias_on_key_update';
const U = 'aaaaaaaa-0000-0000-0000-000000000001';
const V = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACC = 'aaaaaaaa-1111-0000-0000-000000000001';
const ACC_V = 'bbbbbbbb-1111-0000-0000-000000000002';

// Rows from before the sync wrote merchant_key, and what the backfill (normalizeMerchant) keys them as.
const ROWS = [
  // ref, user, account, creditor_name, key the backfill sets, amount, custom_name
  ['exact', U, ACC, 'ACME* Pro Sub', 'acme', 9, null], // its own name's alias beats the key's newer one
  ['bykey', U, ACC, 'ACME 4521', 'acme', 9, null], // no alias of its own: the newest for the key
  ['tie', U, ACC, 'LIDL 4521 MILANO IT', 'lidl', 5, null], // same created_at: first source_name
  ['named', U, ACC, 'ACME 4521', 'acme', 9, 'Mine'], // named by hand: untouched
  ['pp', U, ACC, 'PAYPAL *P1A2B3C4D5', 'paypal', 7, null], // another PayPal payee's alias: none
  ['ppown', U, ACC, 'PAYPAL *P9F8E7D6C5', 'paypal', 7, null], // its own exact name: yes
  ['other', V, ACC_V, 'ACME 4521', 'acme', 9, null], // another user's aliases: none
  ['apple', U, ACC, 'APPLE.COM/BILL', 'apple', 2.99, null], // priced aliases: the one at its price
];
const ALIASES = [
  // user, source_name, alias, merchant_key, created_at
  [U, 'ACME* Pro Sub', 'Acme Pro', 'acme', '2026-01-01'],
  [U, 'Acme', 'Acme Credits', 'acme', '2026-06-01'],
  [U, 'Lidl 4521', 'Lidl A', 'lidl', '2026-03-01'],
  [U, 'Lidl 4521 Milano', 'Lidl B', 'lidl', '2026-03-01'],
  [U, 'PAYPAL *P9F8E7D6C5', 'Gym', null, '2026-06-01'],
  [U, 'APPLE.COM/BILL', 'iCloud', null, '2026-01-01', 0.99],
  [U, 'APPLE.COM/BILL', 'Music', null, '2026-02-01', 2.99],
];
// What the old TS path (merchant-key-backfill.ts: bySource ?? (aggregator ? none : byKey)) wrote.
// The old path ignored the price (it took the oldest alias of the name: iCloud); the trigger does not.
const OLD_TS = { exact: 'Acme Pro', bykey: 'Acme Credits', tie: 'Lidl A', named: 'Mine', pp: '-', ppown: 'Gym', other: '-', apple: 'iCloud' };
const EXPECTED = { ...OLD_TS, apple: 'Music' };

test('the alias trigger names rows when the backfill sets merchant_key', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('alias_on_key', { upTo: NAME });
  t.after(drop);
  const seed = () => {
    admin(`delete from public.transactions; delete from public.merchant_aliases`);
    admin(ROWS.map(([ref, user, acc, name, , amount, custom]) =>
      `insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, custom_name)
       values ('${ref}', '${acc}', '${user}', ${amount}, 'EUR', 'DBIT', '2026-11-20', '${name}', ${custom ? `'${custom}'` : 'null'});`).join('\n'));
    // Aliases made after the rows were stored, so only the backfill can name them.
    admin(ALIASES.map(([user, source, alias, key, at, price]) =>
      `insert into public.merchant_aliases (user_id, source_name, alias, merchant_key, created_at, amount)
       values ('${user}', '${source}', '${alias}', ${key ? `'${key}'` : 'null'}, '${at}', ${price ?? 'null'});`).join('\n'));
  };
  // The backfill's write: merchant_key only, on rows that have none.
  const backfill = () => admin(ROWS.map(([ref, , , , key]) =>
    `update public.transactions set merchant_key = '${key}' where entry_reference = '${ref}' and merchant_key is null;`).join('\n'));
  const names = () => Object.fromEntries(ROWS.map(([ref]) =>
    [ref, admin(`select coalesce(custom_name, '-') from public.transactions where entry_reference = '${ref}'`)]));

  admin(`insert into auth.users (id) values ('${U}'), ('${V}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC}', '${U}', 'EUR'), ('${ACC_V}', '${V}', 'EUR');`);
  seed();
  backfill();
  assert.deepStrictEqual(names(), { ...Object.fromEntries(ROWS.map(([ref]) => [ref, '-'])), named: 'Mine' },
    'before: setting merchant_key alone names nothing');

  // The function (settings, body) and trigger as 20261227000000 left them, for the rollback test.
  const definition = () => admin(`select array_to_string(proconfig, ',') || ' ' || md5(prosrc) || ' ' || pg_get_triggerdef(t.oid)
    from pg_proc p join pg_trigger t on t.tgfoid = p.oid where t.tgname = 'trg_apply_merchant_alias'`);
  const before = definition();
  applySql(`supabase/migrations/${NAME}.sql`);

  await t.test('the trigger picks the alias the old TS path picked, aggregators included, price-aware', () => {
    seed();
    backfill();
    assert.deepStrictEqual(names(), EXPECTED);
  });

  await t.test('an update that keeps or clears the key leaves the name alone', () => {
    seed();
    admin(`update public.transactions set merchant_key = 'acme' where entry_reference = 'bykey'`);
    assert.strictEqual(names().bykey, 'Acme Credits');
    // The user clears the name; the sync then upserts the row with the same key again.
    assert.doesNotMatch(as(U, `update public.transactions set custom_name = null where entry_reference = 'bykey'`), /ERROR/);
    admin(`update public.transactions set merchant_key = 'acme', amount = 9 where entry_reference = 'bykey'`);
    assert.strictEqual(names().bykey, '-', 'the same key again (a re-sync) does not rename');
    assert.doesNotMatch(as(U, `update public.transactions set merchant_key = null where entry_reference = 'bykey'`), /ERROR/);
    assert.strictEqual(names().bykey, '-', 'a user clearing the key does not rename');
  });

  await t.test('inserts still take the alias; the function keeps an empty search_path', () => {
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, merchant_key)
      values ('new', '${ACC}', '${U}', 9, 'EUR', 'DBIT', '2026-11-21', 'ACME 4521', 'acme')`);
    assert.strictEqual(admin(`select custom_name from public.transactions where entry_reference = 'new'`), 'Acme Credits');
    assert.strictEqual(admin(`select array_to_string(proconfig, ',') || ' ' || prosecdef from pg_proc where oid = 'public.apply_merchant_alias()'::regprocedure`), 'search_path="" true');
  });

  await t.test('rollback: insert-only trigger and the previous function, exactly; re-apply works', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(definition(), before);
    seed();
    backfill();
    assert.strictEqual(names().bykey, '-');
    applySql(`supabase/migrations/${NAME}.sql`);
    seed();
    backfill();
    assert.deepStrictEqual(names(), EXPECTED);
  });
});
