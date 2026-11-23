// H017: add-holding refuses a stock the user already holds under another key (added by ticker,
// then by ISIN). The rule itself is tested in _shared/holdings.test.ts; this checks the wiring.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const code = fs.readFileSync('supabase/functions/add-holding/index.ts', 'utf8');
const addStock = code.slice(code.indexOf('async function addStock'), code.indexOf('async function addCoin'));

test('addStock refuses a stock held under another key before it inserts', () => {
  const check = addStock.indexOf('await refuseHeldElsewhere(userClient, userId, req.id, key)');
  assert.ok(check >= 0, 'no refuseHeldElsewhere check');
  assert.ok(check < addStock.indexOf('.insert('), 'the check runs after the insert');
});

test('an already held stock answers 409 already_held with its key', () => {
  assert.match(code, /if \(err instanceof AlreadyHeld\) return json\(\{ error: "already_held", key: err\.key \}, 409\);/);
});
