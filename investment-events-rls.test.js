// Two-user proof that investment_events keeps each user's dividends, fees and transfers private,
// run against a real Postgres. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a
// throwaway server); skipped without it. A fresh database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const db = `events_rls_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);

function psql(target, args) {
  return execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function as(role, sub, sql) {
  const claims = sub ? `set local request.jwt.claims = '{"sub":"${sub}"}';` : '';
  try {
    return psql(dbUrl(), ['-c', `begin; set local role ${role}; ${claims} ${sql}; rollback;`]);
  } catch (e) {
    return `ERROR ${String(e.stderr)}`;
  }
}

test('investment_events RLS with two users', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql']);
  for (const m of ['20261108000000_holding_trades', '20261201000000_holding_trades_external_id', '20261215000000_investment_events'])
    psql(dbUrl(), ['-f', `supabase/migrations/${m}.sql`]);
  psql(dbUrl(), [
    '-c',
    `insert into auth.users values ('${A}'), ('${B}');
     insert into public.investment_events (user_id, kind, event_date, amount_eur, raw_type, source, external_id) values
       ('${A}', 'dividend', '2026-03-01', 5, 'CASH|DIVIDEND', 'trade_republic', 'x'),
       ('${B}', 'interest', '2026-03-01', 2, 'CASH|INTEREST_PAYMENT', 'trade_republic', 'x');`,
  ]);

  await t.test('a user reads only their own events', () => {
    assert.strictEqual(as('authenticated', B, 'select string_agg(kind, \',\') from public.investment_events'), 'interest');
  });

  await t.test("a user can't change, delete or take over another user's events", () => {
    assert.strictEqual(as('authenticated', B, `update public.investment_events set amount_eur = 1 where user_id = '${A}' returning 1`), '');
    assert.strictEqual(as('authenticated', B, `delete from public.investment_events where user_id = '${A}' returning 1`), '');
    assert.match(as('authenticated', B, `update public.investment_events set user_id = '${A}'`), /row-level security/);
  });

  await t.test("a user can't write events for another user", () => {
    const insert = `insert into public.investment_events (user_id, kind, event_date, amount_eur, raw_type) values ('${A}', 'fee', '2026-03-01', -1, 'X')`;
    assert.match(as('authenticated', B, insert), /row-level security/);
  });

  await t.test('a signed-in user saves events for themselves, and a re-import is skipped', () => {
    assert.strictEqual(
      as('authenticated', B, `insert into public.investment_events (kind, event_date, amount_eur, raw_type) values ('fee', '2026-03-01', -1, 'X') returning user_id`),
      B,
    );
    // B's own 'x' exists: skipped. A's 'x' is invisible to B and doesn't block B either.
    assert.strictEqual(
      as('authenticated', B, `insert into public.investment_events (kind, event_date, amount_eur, raw_type, source, external_id) values ('interest', '2026-03-01', 2, 'X', 'trade_republic', 'x') on conflict (user_id, source, external_id) do nothing returning 1`),
      '',
    );
  });

  await t.test('anon sees nothing and nobody can empty the table', () => {
    assert.match(as('anon', null, 'select count(*) from public.investment_events'), /permission denied/);
    assert.match(as('authenticated', B, 'truncate public.investment_events'), /permission denied/);
  });
});
