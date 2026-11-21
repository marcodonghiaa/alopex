// Polish 1 #3: an Edge Function never imports from another function's folder; shared code
// (like the sign-in check in _shared/caller.ts) lives in _shared, so one fix reaches every caller.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = 'supabase/functions';

test('no Edge Function imports from another function\'s folder', () => {
  const offenders = [];
  for (const fn of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!fn.isDirectory() || fn.name.startsWith('_')) continue;
    for (const file of fs.readdirSync(path.join(ROOT, fn.name)).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(ROOT, fn.name, file), 'utf8');
      for (const [, spec] of src.matchAll(/from\s+["'](\.\.\/[^"']+)["']/g)) {
        if (!spec.startsWith('../_shared/')) offenders.push(`${fn.name}/${file}: ${spec}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, []);
});
