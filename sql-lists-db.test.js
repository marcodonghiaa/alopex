// Lists the SQL functions hardcode that also live in the Edge Functions' TypeScript: checked on a
// real Postgres with every migration, so changing one side alone fails CI.
// Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { fullChainDb, skip } = require('./full-chain-db');

/** The string literals of the first `export const NAME = [...]` in a TypeScript file. */
const tsList = (file, name) => {
  const body = fs.readFileSync(file, 'utf8').match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))[1];
  return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
};
const sqlStrings = (text) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);

test('SQL lists match the TypeScript ones', { skip }, async (t) => {
  const { admin, drop } = fullChainDb('sql_lists');
  t.after(drop);
  const source = (fn) => admin(`select pg_get_functiondef('public.${fn}'::regproc)`);

  // H276: aggregator merchant keys (PayPal, Apple, Google) never get a merchant-wide alias.
  await t.test('aggregator keys in the alias functions match merchant-key.ts AGGREGATORS', () => {
    const aggregators = tsList('supabase/functions/_shared/merchant-key.ts', 'AGGREGATORS');
    for (const fn of ['apply_merchant_alias', 'rename_merchant']) {
      const lists = [...source(fn).matchAll(/merchant_key not in \(([^)]*)\)|v_key in \(([^)]*)\)/g)].map((m) => sqlStrings(m[1] ?? m[2]));
      assert.ok(lists.length > 0, `${fn} has no aggregator list`);
      for (const list of lists) assert.deepEqual(list, aggregators, fn);
    }
  });

  // H277: move_category tells the built-in categories from the user's own ones.
  await t.test("move_category's built-in categories match categories.ts CATEGORIES", () => {
    const builtin = source('move_category').match(/builtin constant text\[\] := array\[([^\]]*)\]/);
    assert.ok(builtin, 'move_category has no builtin list');
    assert.deepEqual(sqlStrings(builtin[1]), tsList('supabase/functions/_shared/categories.ts', 'CATEGORIES'));
  });
});
