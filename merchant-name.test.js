const test = require('node:test');
const assert = require('node:assert');
const { cleanMerchantName } = require('./merchant-name');
const cases = require('./supabase/functions/_shared/merchant-name.cases.json');

test('cleans raw bank merchant text like the app does', () => {
  for (const [raw, clean] of cases.clean) assert.strictEqual(cleanMerchantName(raw), clean, raw);
});

test('leaves plain names alone and never returns an empty one', () => {
  for (const name of cases.keep) assert.strictEqual(cleanMerchantName(name), name);
  assert.strictEqual(cleanMerchantName('SQ *'), 'SQ');
  assert.strictEqual(cleanMerchantName(null), null);
});

test('cleans very long bank text without stalling', () => {
  const start = Date.now();
  for (const raw of ['-'.repeat(50000) + 'x', 'a'.repeat(50000), 'PAYPAL *' + 'A'.repeat(50000) + '1'])
    cleanMerchantName(raw);
  assert.ok(Date.now() - start < 100);
});
