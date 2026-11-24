// H086: one shared "latest rate on or before the date, EUR = 1" lookup (20270106000000_fx_rate_to_eur),
// on a real Postgres with every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270106000000_fx_rate_to_eur';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';

test('fx_rate_to_eur', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('fx_rate_to_eur');
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}');
    insert into public.fx_rates (currency, date, rate_to_eur) values
      ('USD', '2026-01-01', 0.9), ('USD', '2026-02-01', 0.8), ('EUR', '2026-01-01', 1);`);
  const rate = (cur, d) => as(A, `select coalesce(public.fx_rate_to_eur(${cur}, ${d})::text, 'null')`);

  await t.test('latest rate on or before the date; EUR is 1 without a row; unknown is null', () => {
    assert.strictEqual(rate("'USD'", "'2026-01-15'"), '0.9');
    assert.strictEqual(rate("'USD'", "'2026-03-01'"), '0.8');
    assert.strictEqual(rate("'USD'", "'2025-12-31'"), 'null');
    assert.strictEqual(rate("'EUR'", "'1999-01-01'"), '1');
    assert.strictEqual(rate("'GBP'", "'2026-03-01'"), 'null');
    assert.strictEqual(rate('null', "'2026-03-01'"), 'null');
  });

  await t.test('stays inlinable: plain SQL, stable, no SET clause', () => {
    assert.strictEqual(admin(`select p.prolang = (select oid from pg_language where lanname = 'sql') and p.provolatile = 's'
      and p.proconfig is null and not p.prosecdef from pg_proc p where p.oid = 'public.fx_rate_to_eur(text, date)'::regprocedure`), 't');
  });

  await t.test('rollback removes it; re-apply works', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(admin(`select to_regprocedure('public.fx_rate_to_eur(text, date)') is null`), 't');
    applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(rate("'USD'", "'2026-03-01'"), '0.8');
  });
});
