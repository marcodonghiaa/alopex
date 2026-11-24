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
  'add_manual_debt', 'add_manual_transaction', 'count_splitwise_review', 'delete_holding',
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

  // H268: a server-only table (RLS on, no policy) relied on RLS alone; one `disable row level
  // security` would have opened it. It must also grant nothing to anon or authenticated.
  await t.test('a table with no policy grants nothing to anon or authenticated', () => {
    assert.deepEqual(list(admin(`select string_agg(c.relname, ',') from pg_class c where c.${pub} and c.relkind in ('r', 'p')
      and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
      and (has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger')
        or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate,references,trigger'))`)), []);
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
    // H267: without pg_temp last, a session's temp tables are searched before public, so the
    // legacy ones must at least end in pg_temp.
    assert.deepEqual(list(admin(`select string_agg(p.proname, ',') ${defs}
      and not ('search_path=""' = any(coalesce(p.proconfig, '{}')))
      and not ('search_path=public, pg_temp' = any(coalesce(p.proconfig, '{}')))`)), []);
  });

  await t.test('anon can run no security definer function, except the MFA check policies use', () => {
    assert.deepEqual(list(admin(`select string_agg(p.oid::regprocedure::text, ',') from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')`)), ANON_DEFINER);
  });

  await t.test("every public view runs as the caller (security_invoker), so RLS applies", () => {
    assert.deepEqual(list(admin(`select string_agg(relname, ',') from pg_class where ${pub} and relkind = 'v'
      and not coalesce('security_invoker=true' = any(reloptions), false)`)), []);
  });

  // H238: deleting a user (or one of their accounts) must remove every row that belongs to them.
  // 20261125 turned the old foreign keys into cascades; later tables each declare it by hand.
  await t.test('every foreign key to auth.users or accounts cascades on delete', () => {
    assert.ok(Number(admin(`select count(*) from pg_constraint where contype = 'f' and confrelid = 'auth.users'::regclass`)) > 10);
    assert.deepEqual(list(admin(`select string_agg(conrelid::regclass || '.' || conname, ',') from pg_constraint
      where contype = 'f' and confrelid in ('auth.users'::regclass, 'public.accounts'::regclass) and confdeltype <> 'c'`)), []);
  });
});
