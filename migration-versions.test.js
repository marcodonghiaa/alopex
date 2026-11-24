const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { execFileSync } = require('node:child_process');

// Supabase records each migration by the number before the first "_": two files with the same
// number make `supabase db push` stop half-way on a fresh install (duplicate key in schema_migrations).
test('every migration has its own version number', () => {
  const versions = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).map((f) => f.split('_')[0]);
  const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
  assert.deepEqual(dupes, []);
});

// polish-5 #2: a self-hoster only learns what to run, and in which order, from UPGRADING.md.
test('migrations from 20261104 on (when release notes started) are named in UPGRADING.md', () => {
  const notes = fs.readFileSync('UPGRADING.md', 'utf8');
  const recent = fs.readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql') && f.split('_')[0] >= '20261104000000')
    .map((f) => f.replace(/\.sql$/, ''));
  assert.deepEqual(recent.filter((name) => !notes.includes(`\`${name}\``)), [], 'missing from UPGRADING.md');
  assert.match(notes, /dashboard first/i);
});

// H084: `supabase db push` refuses a migration whose version sorts below one the database already
// has ("Found local migration files to be inserted before the last migration on remote"), so an
// update would stop. Every migration this branch adds must sort above everything on main. Needs
// origin/main (CI fetches full history); skipped without it.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let base = null;
try { base = git('merge-base', 'HEAD', process.env.MIGRATION_BASE_REF || 'origin/main'); } catch { /* no git or no main */ }
test('migrations added on this branch sort after every migration on main', { skip: base ? false : 'origin/main not available' }, () => {
  const onMain = git('ls-tree', '--name-only', base, 'supabase/migrations/').split('\n')
    .map((f) => f.split('/').pop()).filter((f) => f.endsWith('.sql'));
  const newest = onMain.map((f) => f.split('_')[0]).sort().pop();
  const added = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql') && !onMain.includes(f));
  assert.deepEqual(added.filter((f) => f.split('_')[0] <= newest), [], `new migrations must have a version above ${newest}`);
});
