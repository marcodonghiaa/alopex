// Holding quantity checks (20261225000000_holding_quantity_checks) on a real Postgres with every
// migration before it: a NaN, infinite or negative quantity is refused on new writes, while
// rows already stored are left alone. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a
// throwaway server); skipped without it. A fresh database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const NAME = '20261225000000_holding_quantity_checks';
const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const db = `holding_qty_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();

const psql = (target, args) => execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const admin = (q) => psql(dbUrl(), ['-c', q]);
const applySql = (file) => execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
  input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
  stdio: ['pipe', 'pipe', 'pipe'],
});
// As the signed-in user, the way the dashboard writes (RLS). Errors come back as text.
const as = (q) => {
  try {
    return psql(dbUrl(), ['-c', `begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${A}","role":"authenticated"}'; ${q}; commit;`]);
  } catch (e) {
    return `ERROR ${String(e.stderr)}`;
  }
};
const stock = (isin, shares) => as(`insert into public.portfolio_holdings (user_id, isin, yahoo_symbol, name, shares, broker_label) values ('${A}', '${isin}', 'X', 'X', ${shares}, 'Manual')`);
const coin = (symbol, amount) => as(`insert into public.crypto_holdings (user_id, asset_symbol, name, amount, source, coingecko_id) values ('${A}', '${symbol}', 'X', ${amount}, 'Manual', 'x')`);

test('holding quantity checks migration', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  admin(`insert into auth.users (id) values ('${A}')`);
  // Before: any numeric is accepted, NaN included.
  assert.strictEqual(stock('OLD', `'NaN'`), '');
  assert.strictEqual(coin('OLD', `'Infinity'`), '');

  await t.test('applies over rows already stored, and leaves them as they are', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(admin(`select shares from public.portfolio_holdings where isin = 'OLD'`), 'NaN');
    assert.strictEqual(admin(`select amount from public.crypto_holdings where asset_symbol = 'OLD'`), 'Infinity');
  });

  await t.test('new NaN, infinite or negative quantities are refused', () => {
    for (const bad of [`'NaN'`, `'Infinity'`, `'-Infinity'`, '-1']) {
      assert.match(stock(`S${bad.replace(/\W/g, '')}`, bad), /portfolio_holdings_shares_ok/, bad);
      assert.match(coin(`C${bad.replace(/\W/g, '')}`, bad), /crypto_holdings_amount_ok/, bad);
    }
  });

  // A meme coin can be held in the trillions: any finite amount is real (the price sync skips one
  // too big to value).
  await t.test('real quantities, zero and meme-coin sizes included, are still accepted', () => {
    for (const [i, ok] of ['0', '2.5', '1e12', '5e15'].entries()) {
      assert.strictEqual(stock(`OK${i}`, ok), '', ok);
      assert.strictEqual(coin(`OK${i}`, ok), '', ok);
    }
  });

  await t.test('re-running is safe, and the rollback drops both checks', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(admin(`select count(*) from pg_constraint where conname in ('portfolio_holdings_shares_ok', 'crypto_holdings_amount_ok')`), '0');
    assert.strictEqual(stock('AFTER', `'NaN'`), '');
  });
});
