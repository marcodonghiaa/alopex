// H017: add-holding refuses a stock the user already holds under another key (added by ticker,
// then by ISIN), answering 409 { error: "already_held", key } as the dashboard's import expects.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const code = fs.readFileSync('supabase/functions/add-holding/index.ts', 'utf8');
const addStock = code.slice(code.indexOf('async function addStock'), code.indexOf('async function addCoin'));

test('addStock looks for the same Yahoo symbol before it inserts', () => {
  const check = addStock.indexOf('await heldKey(userClient, userId, req.id)');
  assert.ok(check >= 0, 'no heldKey check');
  assert.ok(check < addStock.indexOf('.insert('), 'heldKey runs after the insert');
  assert.match(addStock, /if \(held\) throw new AlreadyHeld\(held\)/);
});

test('an already held stock answers 409 already_held with its key', () => {
  assert.match(code, /if \(err instanceof AlreadyHeld\) return json\(\{ error: "already_held", key: err\.key \}, 409\);/);
});
