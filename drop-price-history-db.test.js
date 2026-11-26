// H266: 20270122000000_drop_price_history drops the unused price_history table, holding_performance
// still runs without it, and the rollback brings back an empty table with the same access.
// Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270122000000_drop_price_history';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const EXISTS = `select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'price_history'`;

test('drop price_history', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('drop_price_history', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.price_history (provider, symbol, price_date, price, currency)
    values ('yahoo', 'VWCE.DE', '2026-10-01', 100, 'EUR')`);
  applySql(`supabase/migrations/${NAME}.sql`);
  applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run

  await t.test('the table is gone', () => {
    assert.strictEqual(admin(EXISTS), '0');
  });

  await t.test('holding_performance still runs', () => {
    assert.doesNotMatch(as(A, `select count(*) from public.holding_performance('2026-01-01')`), /ERROR/);
  });

  await t.test('the rollback brings back an empty table, readable by signed-in users only', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(admin(EXISTS), '1');
    assert.strictEqual(as(A, `select count(*) from public.price_history`), '0');
    assert.match(as(A, `insert into public.price_history (provider, symbol, price_date, price, currency) values ('yahoo', 'X', '2026-10-01', 1, 'EUR')`), /permission denied/);
  });
});
