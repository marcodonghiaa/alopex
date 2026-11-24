// H046: holding_performance stops reading price_history, which nothing has written since the
// backfill script was removed (20270107000000_holding_performance_no_price_history). The table and
// its rows stay. Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270107000000_holding_performance_no_price_history';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';

test('holding_performance without price_history', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('hp_no_history', { upTo: NAME });
  t.after(drop);
  // One stock and one coin, each with snapshots from 6 Oct and a stray history row on 30 Sep.
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.fx_rates (currency, date, rate_to_eur) values ('USD', '2026-09-01', 0.5);
    insert into public.portfolio_holdings (user_id, isin, yahoo_symbol, name, shares, broker_label, asset_type)
      values ('${A}', 'US0000000001', 'AAA', 'Acme', 10, 'T', 'Stock');
    insert into public.portfolio_snapshots (user_id, isin, snapshot_date, price, currency, value_native, value_eur) values
      ('${A}', 'US0000000001', '2026-10-06', 100, 'USD', 1000, 500), ('${A}', 'US0000000001', '2026-10-30', 120, 'USD', 1200, 600);
    insert into public.crypto_holdings (user_id, source, asset_symbol, name, amount, coingecko_id)
      values ('${A}', 'Ledger', 'BTC', 'Bitcoin', 1, 'bitcoin');
    insert into public.crypto_snapshots (user_id, source, asset_symbol, snapshot_date, amount, price_usd, value_usd, value_eur) values
      ('${A}', 'Ledger', 'BTC', '2026-10-06', 1, 1000, 1000, 500), ('${A}', 'Ledger', 'BTC', '2026-10-30', 1, 2000, 2000, 1000);
    insert into public.price_history (provider, symbol, price_date, price, currency) values
      ('yahoo', 'AAA', '2026-09-30', 95, 'USD'), ('coingecko', 'bitcoin', '2026-09-30', 900, 'USD');`);
  const perf = () => as(A, `select string_agg(concat_ws(' ', key, start_date, start_price_eur::numeric(12,2), end_date, end_price_eur::numeric(12,2), status), ',' order by key)
    from public.holding_performance('2026-10-01')`);
  const columns = () => admin(`select pg_get_function_result('public.holding_performance(date, boolean)'::regprocedure)`);
  const before = columns();

  await t.test('history rows no longer set the start price: the range starts at the first snapshot', () => {
    assert.match(perf(), /^BTC 2026-09-30 450\.00 .* ok,US0000000001 2026-09-30 47\.50 .* ok$/); // old behaviour
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(perf(), 'BTC 2026-10-06 500.00 2026-10-30 1000.00 since,US0000000001 2026-10-06 50.00 2026-10-30 60.00 since');
    assert.doesNotMatch(admin(`select prosrc from pg_proc where oid = 'public.holding_performance(date, boolean)'::regprocedure`), /price_history/);
  });

  await t.test('same result columns; the table and its rows stay', () => {
    assert.strictEqual(columns(), before);
    assert.strictEqual(admin('select count(*) from public.price_history'), '2');
  });

  await t.test('rollback reads history again; re-apply works', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.match(perf(), /,US0000000001 2026-09-30 47\.50 .* ok$/);
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.match(perf(), /,US0000000001 2026-10-06 50\.00 .* since$/);
  });
});
