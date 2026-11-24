// Shared harness for *-db.test.js files: a fresh database on RLS_TEST_DATABASE_URL (a superuser URL
// to a throwaway server) with the Supabase shims and every migration (or those before `upTo`).
// `skip` is the node:test skip reason when no URL is set.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();

const run = (target, args, input) => execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
}).trim();
const errorOf = (fn) => {
  try { return fn(); } catch (e) { return `ERROR: ${String(e.stderr || e.message).trim()}`; }
};

/** Creates the database and returns helpers; call `drop` from t.after. */
function fullChainDb(name, { upTo } = {}) {
  const db = `${name}_${process.pid}`;
  const dbUrl = url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
  run(url, ['-c', `drop database if exists ${db} with (force)`]);
  run(url, ['-c', `create database ${db}`]);
  const applySql = (file) => run(dbUrl, ['-1'],
    fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''));
  run(dbUrl, ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => !upTo || f < `${upTo}.sql`)) applySql(`supabase/migrations/${f}`);
  const admin = (q) => run(dbUrl, ['-c', q]);
  // q as signed-in user `sub` (RLS, security_invoker views); commits. Errors come back as text.
  const as = (sub, q) => errorOf(() => run(dbUrl, ['-c',
    `begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${sub}","role":"authenticated"}'; ${q}; commit;`]));
  return { admin, as, applySql, drop: () => run(url, ['-c', `drop database if exists ${db} with (force)`]) };
}

module.exports = { fullChainDb, skip, MIGRATIONS };
