// H011: in post-sync every step runs on its own (runStep), so one step that throws can't skip the
// steps after it (flows, transfer pairs, refunds, broker matching) for every user.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const code = fs.readFileSync('supabase/functions/post-sync/index.ts', 'utf8');
const STEPS = ['categorize', 'classifyTypes', 'categorizeSplitwise', 'classifyFlows', 'pairTransfers', 'markRefunds', 'matchBrokerRows'];

test('each post-sync step is wrapped in its own runStep', () => {
  for (const step of STEPS) {
    assert.match(code, new RegExp(`runStep\\("\\w+", stepsFailed, \\(\\) => ${step}\\(`), step);
  }
});

test('a failed step still makes post-sync answer 500', () => {
  assert.match(code, /const failed = stepsFailed\.length > 0 \|\|/);
});
