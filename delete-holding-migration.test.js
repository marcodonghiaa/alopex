const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const dir = 'supabase/migrations/';
const strip = (f) => fs.readFileSync(dir + f, 'utf8').replace(/--.*$/gm, '');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
// Check the newest definition: a later `create or replace` replaces the whole function.
const latest = files.filter((f) => /function public\.delete_holding\(/.test(strip(f))).pop();
const code = strip(latest);
// `create or replace` keeps grants, so the revoke may live in an older migration.
const all = files.map(strip).join('\n');

// delete_holding runs as security definer, so RLS does not protect anyone: every delete must
// itself be limited to the caller.
test('every delete in delete_holding is limited to the caller', () => {
  const deletes = code.match(/delete from[^;]*;/g);
  assert.ok(deletes.length >= 6);
  for (const d of deletes) assert.match(d, /user_id = v_uid/, d);
});

test('delete_holding refuses a caller who is not signed in', () => {
  assert.match(code, /v_uid uuid := auth\.uid\(\)/);
  assert.match(code, /if v_uid is null then\s+raise exception/);
});

test('delete_holding also deletes the holding events', () => {
  assert.match(code, /delete from investment_events where user_id = v_uid/);
});

test('anon cannot call delete_holding', () => {
  assert.match(all, /revoke execute on function public\.delete_holding\(text, text, text\) from public, anon;/);
  assert.doesNotMatch(all, /grant execute on function public\.delete_holding[^;]*\banon\b/);
});
