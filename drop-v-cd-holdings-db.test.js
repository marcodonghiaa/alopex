// H108: the unused v_cd_holdings view goes (20270108000000_drop_v_cd_holdings). Deposits left the
// app in 20261130; the cd_holdings table and its rows stay (still in the data export), marked
// deprecated. Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270108000000_drop_v_cd_holdings';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';

test('drop v_cd_holdings, keep cd_holdings', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('drop_v_cd', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.cd_holdings (user_id, label, currency, principal, annual_rate, start_date, maturity_date)
      values ('${A}', 'CD', 'EUR', 1000, 0.03, '2026-01-01', '2027-01-01');`);
  const view = () => admin(`select to_regclass('public.v_cd_holdings') is not null`);

  await t.test('the view is gone; the table and its rows stay, readable by the owner', () => {
    assert.strictEqual(view(), 't');
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(view(), 'f');
    assert.strictEqual(as(A, 'select count(*) from public.cd_holdings'), '1');
    assert.match(admin(`select obj_description('public.cd_holdings'::regclass)`), /Deprecated/);
  });

  await t.test('safe to re-run; rollback brings the view back', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(as(A, 'select round(principal) from public.v_cd_holdings'), '1000');
    assert.match(admin(`select array_to_string(reloptions, ',') from pg_class where oid = 'public.v_cd_holdings'::regclass`), /security_invoker=true/);
  });
});
