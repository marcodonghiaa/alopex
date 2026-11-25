// H189: holding_trades shares, price and fee refuse NaN and Infinity on new writes
// (20270116000000_holding_trades_finite). NaN sorts above every number in Postgres, so the old
// `shares > 0` passed it and one NaN trade turned the holding's returns into NaN. Rows stored
// before are left alone. Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270116000000_holding_trades_finite';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';

test('holding_trades numbers are finite', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('holding_trades_finite', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}')`);
  const trade = (shares, price = '10', fee = '0') => as(A, `insert into public.holding_trades
    (user_id, kind, key, side, trade_date, shares, price_eur, fee_eur)
    values ('${A}', 'stock', 'IE00B4L5Y983', 'buy', '2026-01-02', ${shares}, ${price}, ${fee})`);

  await t.test('before: a NaN trade is stored', () => {
    assert.doesNotMatch(trade(`'NaN'`), /ERROR/);
    applySql(`supabase/migrations/${NAME}.sql`);
    applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run
    assert.strictEqual(admin(`select count(*) from public.holding_trades where shares = 'NaN'`), '1');
  });

  await t.test('NaN or Infinity in shares, price or fee is refused', () => {
    for (const [s, p, f] of [[`'NaN'`, '10', '0'], [`'Infinity'`, '10', '0'], ['1', `'NaN'`, '0'], ['1', `'Infinity'`, '0'], ['1', '10', `'NaN'`], ['1', '10', `'Infinity'`]]) {
      assert.match(trade(s, p, f), /holding_trades_numbers_finite/, `${s} ${p} ${f}`);
    }
  });

  await t.test('real trades still go in, and the old rules still hold', () => {
    assert.doesNotMatch(trade('0.000001', '0', '0'), /ERROR/);
    assert.doesNotMatch(trade('1e12', '123456.78', '9.99'), /ERROR/);
    assert.match(trade('0'), /check constraint/);
    assert.match(trade('1', '-1'), /check constraint/);
  });

  await t.test('the stored NaN row can still be deleted or fixed', () => {
    assert.doesNotMatch(as(A, `update public.holding_trades set shares = 1 where shares = 'NaN'`), /ERROR/);
  });

  await t.test('the rollback drops the check', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.doesNotMatch(trade(`'NaN'`), /ERROR/);
  });
});
