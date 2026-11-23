// resolve_transfer_pair (20261229000000_reject_pair_keeps_bank_transfer): rejecting a pair puts
// only the side post-sync paired back to spend or income; a side the bank code already called a
// transfer (EXCHANGE, TOPUP) stays a transfer. Needs psql and RLS_TEST_DATABASE_URL (a superuser
// URL to a scratch Postgres).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const db = `reject_pair_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const NAME = '20261229000000_reject_pair_keeps_bank_transfer';
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const OUT = 'aaaaaaaa-1111-0000-0000-000000000001';
const IN = 'aaaaaaaa-1111-0000-0000-000000000002';
const PAIR = 'cccccccc-0000-0000-0000-000000000001';

const psql = (target, args) => execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const sql = (q) => psql(dbUrl(), ['-c', q]);
const asA = (q) => {
  try {
    return psql(dbUrl(), ['-c', `begin; set local role authenticated;
      set local request.jwt.claims = '{"sub":"${A}","role":"authenticated"}'; ${q}; commit;`]);
  } catch (e) {
    return `ERROR ${String(e.stderr)}`;
  }
};
const applySql = (file) => execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
  input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
  stdio: ['pipe', 'pipe', 'pipe'],
});
// A pair: out (DBIT) and in (CRDT), with the flow_source each side had when it was suggested.
const seed = (outSource, inSource) => sql(`delete from public.transfer_pairs; delete from public.transactions;
  insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, flow_type, flow_source)
  values ('o', '${OUT}', '${A}', 50, 'EUR', 'DBIT', '2026-11-10', 'transfer', '${outSource}'),
         ('i', '${IN}', '${A}', 50, 'EUR', 'CRDT', '2026-11-10', 'transfer', '${inSource}');
  insert into public.transfer_pairs (id, user_id, out_account_uid, out_ref, in_account_uid, in_ref)
  values ('${PAIR}', '${A}', '${OUT}', 'o', '${IN}', 'i');`);
const flows = () => sql(`select string_agg(entry_reference || '=' || flow_type || '/' || flow_source, ',' order by entry_reference)
  from public.transactions`);

test('rejecting a transfer pair', { skip }, async (t) => {
  psql(url, ['-c', `drop database if exists ${db} with (force)`]);
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < `${NAME}.sql`)) applySql(`supabase/migrations/${f}`);
  sql(`insert into auth.users (id) values ('${A}');
    insert into public.accounts (uid, user_id, currency) values ('${OUT}', '${A}', 'EUR'), ('${IN}', '${A}', 'EUR');`);
  applySql(`supabase/migrations/${NAME}.sql`);
  applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run

  await t.test('a bank-coded side stays a transfer; only the paired side counts again', () => {
    seed('bank', 'pair');
    assert.strictEqual(asA(`select public.resolve_transfer_pair('${PAIR}', false)`), '');
    assert.strictEqual(flows(), 'i=income/user,o=transfer/bank');
    assert.strictEqual(sql(`select status from public.transfer_pairs`), 'rejected');
  });

  await t.test('two paired sides both count again, as before', () => {
    seed('pair', 'pair');
    asA(`select public.resolve_transfer_pair('${PAIR}', false)`);
    assert.strictEqual(flows(), 'i=income/user,o=spend/user');
  });

  await t.test('confirming still makes both sides your transfer', () => {
    seed('bank', 'pair');
    asA(`select public.resolve_transfer_pair('${PAIR}', true)`);
    assert.strictEqual(flows(), 'i=transfer/user,o=transfer/user');
  });

  await t.test('a side you changed since makes the pair stale: nothing changes', () => {
    seed('bank', 'user');
    assert.match(asA(`select public.resolve_transfer_pair('${PAIR}', false)`), /stale/);
    assert.strictEqual(flows(), 'i=transfer/user,o=transfer/bank');
    assert.strictEqual(sql(`select status from public.transfer_pairs`), 'suggested');
  });

  await t.test('rolls back to rejecting both sides', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    seed('bank', 'pair');
    asA(`select public.resolve_transfer_pair('${PAIR}', false)`);
    assert.strictEqual(flows(), 'i=income/user,o=spend/user');
  });
});
