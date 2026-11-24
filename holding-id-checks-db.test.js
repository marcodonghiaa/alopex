// Holding id checks (20270101000000_holding_id_checks) on a real Postgres with every
// migration before it: an overlong symbol or a malformed CoinGecko id is refused on new writes, while
// rows already stored are left alone. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a
// throwaway server); skipped without it. A fresh database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const NAME = '20270101000000_holding_id_checks';
const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const db = `holding_ids_${process.pid}`;
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
const stock = (isin, symbol) => as(`insert into public.portfolio_holdings (user_id, isin, yahoo_symbol, name, shares, broker_label) values ('${A}', '${isin}', '${symbol}', 'X', 1, 'Manual')`);
const coin = (symbol, id) => as(`insert into public.crypto_holdings (user_id, asset_symbol, name, amount, source, coingecko_id) values ('${A}', '${symbol}', 'X', 1, 'Manual', '${id}')`);
const long = 'x'.repeat(41);

test('holding id checks migration', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  admin(`insert into auth.users (id) values ('${A}')`);
  // Before: any length goes, and one huge or odd id breaks the shared CoinGecko call (H048).
  assert.strictEqual(stock('OLD', long), '');
  assert.strictEqual(coin('OLD', 'Not An Id!'), '');

  await t.test('applies over rows already stored, and leaves them as they are', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(admin(`select yahoo_symbol from public.portfolio_holdings where isin = 'OLD'`), long);
  });

  await t.test('new overlong symbols and malformed CoinGecko ids are refused', () => {
    assert.match(stock('S1', long), /portfolio_holdings_ids_ok/);
    assert.match(stock(long, 'X'), /portfolio_holdings_ids_ok/);
    assert.match(coin('C1', 'Not An Id!'), /crypto_holdings_ids_ok/);
    assert.match(coin(long, 'bitcoin'), /crypto_holdings_ids_ok/);
  });

  await t.test('real ISINs, tickers and CoinGecko ids are still accepted', () => {
    assert.strictEqual(stock('IE00B4L5Y983', 'IWDA.AS'), '');
    assert.strictEqual(stock('VWCE', 'VWCE.DE'), '');
    assert.strictEqual(coin('ETHX', 'stader-ethx'), '');
    assert.strictEqual(coin('AVAX', 'avalanche-2'), '');
  });

  await t.test('re-running is safe, and the rollback drops both checks', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(admin(`select count(*) from pg_constraint where conname in ('portfolio_holdings_ids_ok', 'crypto_holdings_ids_ok')`), '0');
  });
});
