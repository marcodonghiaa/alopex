// H095: schema-wide guards on a real Postgres with every migration, so a new migration that adds a
// table without RLS, a policy not tied to the caller, a definer function without a pinned
// search_path, a definer function anon can run, or a view that runs as its owner fails CI.
// Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

// Shared reference data every signed-in user reads (no owner column).
const SHARED_TABLES = ['fx_rates', 'price_history'];
// Definer functions written before `set search_path = ''` was the rule (their names are qualified
// or only public is searched). New ones must use ''; leave this list as it is or shrink it.
const LEGACY_PUBLIC_SEARCH_PATH = [
  'add_manual_debt', 'add_manual_transaction', 'apply_merchant_alias', 'count_splitwise_review', 'delete_holding',
  'dismiss_splitwise_review', 'link_splitwise_review', 'reject_splitwise_match', 'set_account_type',
  'set_holding_quantity', 'set_manual_balance', 'splitwise_attempt', 'upsert_detected_streams',
];
// require_mfa runs inside RLS policies, which anon requests evaluate too.
const ANON_DEFINER = ['require_mfa()'];

const list = (rows) => (rows ? rows.split(',').sort() : []);
const inList = (xs) => `(${xs.map((x) => `'${x}'`).join(', ')})`;

test('schema invariants', { skip }, async (t) => {
  const { admin, drop } = fullChainDb('schema_invariants');
  t.after(drop);
  const pub = `relnamespace = 'public'::regnamespace`;

  await t.test('every public table has row level security on', () => {
    assert.ok(Number(admin(`select count(*) from pg_class where ${pub} and relkind in ('r', 'p')`)) > 20);
    assert.deepEqual(list(admin(`select string_agg(relname, ',') from pg_class where ${pub} and relkind in ('r', 'p') and not relrowsecurity`)), []);
  });

  await t.test("every policy is tied to the caller's auth.uid(), except shared reference tables", () => {
    assert.deepEqual(list(admin(`select string_agg(tablename || '.' || policyname, ',') from pg_policies
      where schemaname = 'public' and tablename not in ${inList(SHARED_TABLES)}
        and coalesce(qual, '') || coalesce(with_check, '') !~ 'auth\\.uid\\(\\)'`)), []);
  });

  await t.test("every security definer function pins its search_path (to '' for new ones)", () => {
    const defs = `from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef`;
    assert.deepEqual(list(admin(`select string_agg(p.proname, ',') ${defs}
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`)), []);
    assert.deepEqual(list(admin(`select string_agg(p.proname, ',') ${defs}
      and not ('search_path=""' = any(coalesce(p.proconfig, '{}'))) and p.proname not in ${inList(LEGACY_PUBLIC_SEARCH_PATH)}`)), []);
  });

  await t.test('anon can run no security definer function, except the MFA check policies use', () => {
    assert.deepEqual(list(admin(`select string_agg(p.oid::regprocedure::text, ',') from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')`)), ANON_DEFINER);
  });

  await t.test("every public view runs as the caller (security_invoker), so RLS applies", () => {
    assert.deepEqual(list(admin(`select string_agg(relname, ',') from pg_class where ${pub} and relkind = 'v'
      and not coalesce('security_invoker=true' = any(reloptions), false)`)), []);
  });
});
