// Broker row matching (20261218000000_broker_matching) on a real Postgres with every migration
// before it: Trade Republic bank rows (date + amount only) matched to the CSV import's trades and
// events, labels, flows and categories, ties skipped, hand edits kept, Undo, two users apart. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway
// server); skipped without it. A fresh database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync, execFile } = require('node:child_process');

const MIGRATION = 'supabase/migrations/20261218000000_broker_matching.sql';
const ROLLBACK = 'supabase/rollbacks/20261218000000_broker_matching.down.sql';
const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACC_A = 'aaaaaaaa-1111-0000-0000-000000000001';
const ACC_B = 'bbbbbbbb-1111-0000-0000-000000000002';
const db = `broker_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);

function psql(target, args) {
  return execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const admin = (q) => psql(dbUrl(), ['-c', q]);
// Runs q as signed-in user `sub`; kept unless rollback is asked for. Errors come back as text.
function as(sub, q, { keep = true } = {}) {
  try {
    return psql(dbUrl(), [
      '-c',
      `begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${sub}","role":"authenticated"}'; ${q}; ${keep ? 'commit' : 'rollback'};`,
    ]);
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

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const ACC_A_REV = 'aaaaaaaa-2222-0000-0000-000000000001';
const ISIN = 'IE00TEST0001';
const svc = (q) =>
  psql(dbUrl(), ['-c', `begin; set local role service_role; set local request.jwt.claims = '{"role":"service_role"}'; ${q}; commit;`]);
const row = (ref) =>
  admin(`select concat_ws('|', flow_type, flow_source, coalesce(category, ''), coalesce(category_source, ''), coalesce(broker_label, ''), broker_ref is not null)
           from public.transactions where entry_reference = '${ref}'`);
const viewName = (ref) => admin(`select creditor_name from public.v_transactions_eur where entry_reference = '${ref}'`);

test('broker row matching on a real Postgres', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < MIGRATION.split('/').pop())) applySql(`supabase/migrations/${f}`);
  // Bank rows as the sync and post-sync left them: no names, debit spend / credit income, AI category.
  // A DBIT amount is stored negative on some rows and positive on others: the sign comes from the indicator.
  const bank = (ref, acc, user, amount, cdi, days, currency = 'EUR') =>
    `('${ref}', '${acc}', '${user}', ${amount}, '${currency}', '${cdi}', '${daysAgo(days)}', '${cdi === 'DBIT' ? 'spend' : 'income'}', 'default', 'Others', 'ai')`;
  admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.accounts (uid, user_id, currency, bank_name) values
      ('${ACC_A}', '${A}', 'EUR', 'Trade Republic'), ('${ACC_A_REV}', '${A}', 'EUR', 'Revolut'), ('${ACC_B}', '${B}', 'EUR', 'Trade Republic');
    insert into public.portfolio_holdings (user_id, isin, yahoo_symbol, name, shares, broker_label) values ('${A}', '${ISIN}', 'TEST.DE', 'World ETF', 1, 'Trade Republic');
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, flow_type, flow_source, category, category_source) values
      ${[
        bank('dep', ACC_A, A, 50, 'CRDT', 60),
        bank('buy', ACC_A, A, -50.99, 'DBIT', 59),
        bank('int', ACC_A, A, 1.37, 'CRDT', 30),
        bank('sb', ACC_A, A, 3.04, 'CRDT', 29),
        bank('tax', ACC_A, A, 0.23, 'DBIT', 20),
        bank('late', ACC_A, A, 20, 'DBIT', 10),
        bank('twin1', ACC_A, A, 25, 'DBIT', 5),
        bank('twin2', ACC_A, A, 25, 'DBIT', 5),
        bank('lone', ACC_A, A, 7.77, 'DBIT', 4),
        bank('usd', ACC_A, A, 5.55, 'CRDT', 4, 'USD'),
        bank('rev', ACC_A_REV, A, 50, 'DBIT', 60),
        bank('dep-b', ACC_B, B, 50, 'CRDT', 60),
      ].join(',\n')};
    -- Set by hand before the import: flow and category stay.
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, flow_type, flow_source, category, category_source) values
      ('hand', '${ACC_A}', '${A}', 12, 'EUR', 'DBIT', '${daysAgo(3)}', 'spend', 'user', 'Shopping', 'manual'),
      ('handcat', '${ACC_A}', '${A}', 9, 'EUR', 'DBIT', '${daysAgo(2)}', 'spend', 'default', 'Health', 'manual');
    -- A's Trade Republic CSV import.
    insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, fee_eur, tax_eur, source, external_id) values
      ('${A}', 'stock', '${ISIN}', 'buy', '${daysAgo(59)}', 0.5, 100, 0.99, 0, 'trade_republic', 't-buy'),
      ('${A}', 'stock', '${ISIN}', 'buy', '${daysAgo(12)}', 0.2, 100, 0, 0, 'trade_republic', 't-late'),
      ('${A}', 'stock', '${ISIN}', 'buy', '${daysAgo(5)}', 0.25, 100, 0, 0, 'trade_republic', 't-twin1'),
      ('${A}', 'stock', '${ISIN}', 'buy', '${daysAgo(5)}', 0.25, 100, 0, 0, 'trade_republic', 't-twin2'),
      ('${A}', 'stock', '${ISIN}', 'buy', '${daysAgo(3)}', 0.12, 100, 0, 0, 'trade_republic', 't-hand'),
      ('${A}', 'stock', '${ISIN}', 'buy', '${daysAgo(2)}', 0.09, 100, 0, 0, 'trade_republic', 't-handcat');
    insert into public.investment_events (user_id, kind, event_date, amount_eur, tax_eur, raw_type, source, external_id) values
      ('${A}', 'deposit', '${daysAgo(60)}', 50, 0, 'DEPOSIT', 'trade_republic', 'e-dep'),
      ('${A}', 'interest', '${daysAgo(30)}', 1.37, 0.46, 'INTEREST_PAYMENT', 'trade_republic', 'e-int'),
      ('${A}', 'reward', '${daysAgo(29)}', 3.04, 0, 'BENEFITS_SAVEBACK', 'trade_republic', 'e-sb'),
      ('${A}', 'tax', '${daysAgo(20)}', -0.23, 0, 'TAX_OPTIMIZATION', 'trade_republic', 'e-tax'),
      ('${A}', 'interest', '${daysAgo(4)}', 5.55, 0, 'INTEREST_PAYMENT', 'trade_republic', 'e-usd'),
      ('${A}', 'corporate_action', '${daysAgo(4)}', 7.77, 0, 'SPLIT', 'trade_republic', 'e-split');`);
  applySql(MIGRATION);
  applySql(MIGRATION); // twice: safe to re-run

  await t.test('matches each bank row to its CSV row: flow, category, name', () => {
    assert.strictEqual(as(A, 'select public.match_broker_rows()'), '{"cleared": 0, "matched": 7, "unmatched": 3}');
    assert.strictEqual(row('dep'), 'transfer|broker|Transfer|rule|Deposit|t');
    assert.strictEqual(row('buy'), 'transfer|broker|Transfer|rule|Buy World ETF|t');
    assert.strictEqual(row('int'), 'income|broker|Income|rule|Interest|t');
    assert.strictEqual(row('sb'), 'income|broker|Income|rule|Saveback|t');
    assert.strictEqual(row('tax'), 'spend|broker|Taxes|rule|Tax|t');
    assert.strictEqual(row('late'), 'transfer|broker|Transfer|rule|Buy World ETF|t', 'within 3 days');
    assert.strictEqual(viewName('buy'), 'Buy World ETF');
  });

  await t.test('ties, no candidate, other currencies, other banks and corporate actions stay as they were', () => {
    for (const ref of ['twin1', 'twin2', 'lone']) assert.strictEqual(row(ref), 'spend|default|Others|ai||f', ref);
    assert.strictEqual(row('usd'), 'income|default|Others|ai||f');
    assert.strictEqual(row('rev'), 'spend|default|Others|ai||f');
  });

  await t.test('what you set by hand stays', () => {
    assert.strictEqual(row('hand'), 'spend|user|Shopping|manual||f');
    assert.strictEqual(row('handcat'), 'transfer|broker|Health|manual|Buy World ETF|t');
  });

  await t.test('another user is never matched to my import, nor can I run it for them', () => {
    assert.strictEqual(row('dep-b'), 'income|default|Others|ai||f');
    assert.strictEqual(as(B, 'select public.match_broker_rows()'), '{"cleared": 0, "matched": 0, "unmatched": 1}');
    assert.match(as(A, `select public.match_broker_rows('${B}')`), /only match your own rows/);
    assert.match(
      psql(dbUrl(), ['-c', "select has_function_privilege('anon', 'public.match_broker_rows(uuid)', 'execute')"]),
      /^f$/,
    );
  });

  await t.test('running again changes nothing', () => {
    assert.strictEqual(as(A, 'select public.match_broker_rows()'), '{"cleared": 0, "matched": 0, "unmatched": 3}');
    assert.strictEqual(svc('select public.match_broker_rows()'), '{"cleared": 0, "matched": 0, "unmatched": 4}');
  });

  await t.test('users cannot write broker_ref or broker_label, and their own edits stay theirs', () => {
    assert.match(as(A, "update public.transactions set broker_label = 'Free money' where entry_reference = 'lone'"), /cannot be changed/);
    assert.match(as(A, "update public.transactions set broker_ref = null where entry_reference = 'buy'"), /cannot be changed/);
    as(A, "update public.transactions set flow_type = 'spend' where entry_reference = 'int'");
    assert.strictEqual(row('int'), 'spend|user|Income|rule|Interest|t');
  });

  await t.test('undoing the import puts the rows back', () => {
    as(A, "delete from public.holding_trades where external_id = 't-buy'");
    as(A, "delete from public.investment_events where external_id = 'e-int'");
    assert.strictEqual(as(A, 'select public.match_broker_rows()'), '{"cleared": 2, "matched": 0, "unmatched": 4}');
    assert.strictEqual(row('buy'), 'spend|default||||f');
    assert.strictEqual(row('int'), 'spend|user||||f', 'your flow stays');
    assert.strictEqual(viewName('buy'), '');
  });

  await t.test('rollback removes the new objects; re-apply works', () => {
    applySql(ROLLBACK);
    assert.strictEqual(admin("select count(*) from information_schema.columns where table_name = 'transactions' and column_name in ('broker_ref', 'broker_label')"), '0');
    assert.strictEqual(admin("select count(*) from pg_proc where proname in ('match_broker_rows', 'broker_sources')"), '0');
    assert.strictEqual(admin("select count(*) from public.transactions where flow_source = 'broker'"), '0');
    applySql(MIGRATION);
    assert.strictEqual(as(A, 'select public.match_broker_rows()'), '{"cleared": 0, "matched": 5, "unmatched": 4}');
  });
});
