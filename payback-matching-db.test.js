// Payback matching (20261214000000_payback_matching) on a real Postgres with every migration before
// it: payer keys, the candidates list, record_payback settling bills oldest first, undo, links,
// and two users kept apart. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway
// server); skipped without it. A fresh database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync, execFile } = require('node:child_process');

const MIGRATION = 'supabase/migrations/20261214000000_payback_matching.sql';
const ROLLBACK = 'supabase/rollbacks/20261214000000_payback_matching.down.sql';
const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACC_A = 'aaaaaaaa-1111-0000-0000-000000000001';
const ACC_B = 'bbbbbbbb-1111-0000-0000-000000000002';
const db = `payback_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);

function psql(target, args) {
  return execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const admin = (q) => psql(dbUrl(), ['-c', q]);
// Runs q as signed-in user `sub`; kept unless rollback is asked for. Errors come back as text.
function as(sub, q, { keep = true } = {}) {
  try {
    return psql(dbUrl(), [
      '-c',
      `begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${sub}","role":"authenticated"}'; ${q}; ${keep ? 'commit' : 'rollback'};`,
    ]);
  } catch (e) {
    return `ERROR ${String(e.stderr)}`;
  }
}
const applySql = (file) =>
  execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
    input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

test('payback matching on a real Postgres', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < MIGRATION.split('/').pop())) applySql(`supabase/migrations/${f}`);
  // Rows written before this migration: A split three bills with Anna (one shared with Luca) and got
  // two payments; B has a bill with "Anna" too.
  admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.accounts (uid, user_id, currency) values ('${ACC_A}', '${A}', 'EUR'), ('${ACC_B}', '${B}', 'EUR');
    insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, debtor_name, personal_amount, owed_by)
    values ('bill-1', '${ACC_A}', '${A}', 100, 'EUR', 'DBIT', '${daysAgo(30)}', 'Pizzeria', null, 40, 'Anna'),
           ('bill-2', '${ACC_A}', '${A}', 300, 'EUR', 'DBIT', '${daysAgo(20)}', 'Hotel', null, 100, ' anna '),
           ('bill-3', '${ACC_A}', '${A}', 90, 'EUR', 'DBIT', '${daysAgo(10)}', 'Taxi', null, 30, 'Anna, Luca'),
           ('pay-1', '${ACC_A}', '${A}', 60, 'EUR', 'CRDT', '${daysAgo(5)}', null, 'ANNA  Rossì.', null, null),
           ('pay-2', '${ACC_A}', '${A}', 500, 'EUR', 'CRDT', '${daysAgo(2)}', 'Anna Rossi', null, null, null),
           ('old', '${ACC_A}', '${A}', 50, 'EUR', 'CRDT', '${daysAgo(400)}', null, 'Anna Rossi', null, null),
           ('bill-b', '${ACC_B}', '${B}', 100, 'EUR', 'DBIT', '${daysAgo(30)}', 'Bar', null, 50, 'Anna'),
           ('pay-b', '${ACC_B}', '${B}', 50, 'EUR', 'CRDT', '${daysAgo(3)}', null, 'Anna Rossi', null, null);`);
  applySql(MIGRATION);
  applySql(MIGRATION); // twice: safe to re-run

  await t.test('payer_key ignores case, accents, spacing and punctuation', () => {
    assert.strictEqual(admin("select public.payer_key('  ANNA  Rossì. ')"), 'anna rossi');
    assert.strictEqual(admin("select public.payer_key('Anna-Rossi')"), 'anna rossi');
    assert.strictEqual(admin("select public.payer_key('Řehoř ŁUKASZ Øster Šťastný Dvořák Ćwik Węgrzyn Nagy Ödön Győző Žanić Ålund Ærø Straße')"), 'rehor lukasz oster stastny dvorak cwik wegrzyn nagy odon gyozo zanic alund aero strasse');
    // Cut inside the key, so the link saved for a very long name is found again by the same key.
    assert.strictEqual(admin("select char_length(public.payer_key(repeat('ab ', 150)))"), '200');
    assert.strictEqual(admin("select coalesce(public.payer_key(' .- '), '∅') || coalesce(public.payer_key(null), '∅')"), '∅∅');
    assert.strictEqual(admin("select public.payer_name_of('  ', 'Anna Rossi') || '|' || public.payer_name_of('Debtor', 'Creditor')"), 'Anna Rossi|Debtor');
  });

  await t.test('candidates: recent unchecked payments of the caller only, with the payer', () => {
    assert.strictEqual(
      as(A, "select string_agg(entry_reference || ':' || payer || ':' || amount_eur, ',' order by entry_reference) from public.payback_candidates(60)"),
      'pay-1:ANNA  Rossì.:60.00,pay-2:Anna Rossi:500.00',
    );
    assert.strictEqual(as(B, 'select string_agg(entry_reference, \',\') from public.payback_candidates(60)'), 'pay-b');
    assert.strictEqual(as(A, 'select count(*) from public.payback_candidates(null)'), '2');
    assert.strictEqual(as(A, 'select count(*) from public.payback_candidates(100000)'), '2', 'capped at a year');
  });

  // polish-1 #2: money already counted elsewhere is never offered or accepted as a payback.
  await t.test('only plain income is a candidate: no transfers, Splitwise settle-ups, split refunds, refunds or own money', () => {
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, debtor_name, flow_type, import_batch_id, personal_amount, owed_by, refund_of, own_counterparty)
      values ('x-transfer', '${ACC_A}', '${A}', 60, 'EUR', 'CRDT', '${today}', 'Anna Rossi', 'transfer', null, null, null, null, null),
             ('x-splitwise', '${ACC_A}', '${A}', 60, 'EUR', 'CRDT', '${today}', 'Anna Rossi', null, gen_random_uuid(), null, null, null, null),
             ('x-splitrefund', '${ACC_A}', '${A}', 60, 'EUR', 'CRDT', '${today}', 'Anna Rossi', null, null, 30, 'Anna', null, null),
             ('x-refund', '${ACC_A}', '${A}', 60, 'EUR', 'CRDT', '${today}', 'Anna Rossi', 'refunded', null, null, null, 'bill-1', null),
             ('x-own', '${ACC_A}', '${A}', 60, 'EUR', 'CRDT', '${today}', 'Anna Rossi', null, null, null, null, null, true)`);
    try {
      assert.strictEqual(as(A, "select count(*) from public.payback_candidates(60) where entry_reference like 'x-%'"), '0');
      for (const ref of ['x-transfer', 'x-splitwise', 'x-splitrefund', 'x-refund', 'x-own'])
        assert.match(as(A, `select public.record_payback('${ACC_A}', '${ref}', 'Anna', false)`, { keep: false }), /Payment not found/, ref);
      // A plain income credit the user marked as income by hand is still fine.
      admin("update public.transactions set flow_type = 'income' where entry_reference = 'x-transfer'");
      assert.strictEqual(as(A, "select count(*) from public.payback_candidates(60) where entry_reference = 'x-transfer'"), '1');
    } finally {
      admin("delete from public.transactions where entry_reference like 'x-%'");
    }
  });

  // polish-1 #3: two payments from the same person confirmed at the same moment.
  await t.test('two payments confirmed at once never settle the same bill twice', async () => {
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, debtor_name, personal_amount, owed_by)
      values ('r-bill', '${ACC_A}', '${A}', 100, 'EUR', 'DBIT', '${daysAgo(50)}', null, 50, 'Racer'),
             ('r-pay1', '${ACC_A}', '${A}', 50, 'EUR', 'CRDT', '${today}', 'Racer One', null, null),
             ('r-pay2', '${ACC_A}', '${A}', 50, 'EUR', 'CRDT', '${today}', 'Racer Two', null, null)`);
    const run = (q) =>
      new Promise((resolve) =>
        execFile('psql', [dbUrl(), '-X', '-q', '-t', '-A', '-c', q], (err, out, errOut) => resolve(err ? `ERROR ${errOut}` : out.trim())),
      );
    const signedIn = `set local role authenticated; set local request.jwt.claims = '{"sub":"${A}","role":"authenticated"}';`;
    try {
      // The first holds its transaction open for a second after settling.
      const first = run(`begin; ${signedIn} select public.record_payback('${ACC_A}', 'r-pay1', 'Racer', false); select pg_sleep(1); commit;`);
      await new Promise((r) => setTimeout(r, 300));
      const second = run(`begin; ${signedIn} select public.record_payback('${ACC_A}', 'r-pay2', 'Racer', false); commit;`);
      const outs = await Promise.all([first, second]);
      const settledBy = outs.filter((o) => /"settled": \["r-bill"\]/.test(o)).length;
      assert.strictEqual(settledBy, 1, outs.join('\n'));
    } finally {
      admin("delete from public.transactions where entry_reference like 'r-%'");
    }
  });

  await t.test('a payment covering the oldest bill exactly settles it with nothing left', () => {
    const out = as(A, `select public.record_payback('${ACC_A}', 'pay-1', 'Anna', true)`, { keep: false });
    // bill-1: Anna owes 60 → covered exactly.
    assert.match(out, /"settled": \["bill-1"\]/);
    assert.match(out, /"left_eur": 0/);
  });

  await t.test('a payment short of the oldest bill settles nothing (no skipping to a later one)', () => {
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, debtor_name)
      values ('pay-small', '${ACC_A}', '${A}', 59.99, 'EUR', 'CRDT', '${today}', 'Anna Rossi')`);
    const out = as(A, `select public.record_payback('${ACC_A}', 'pay-small', 'Anna', false)`, { keep: false });
    admin("delete from public.transactions where entry_reference = 'pay-small'");
    assert.match(out, /"settled": \[\]/);
    assert.match(out, /"left_eur": 59.99/);
  });

  await t.test('settles oldest first, whole bills only, skips shared bills, links the payer', () => {
    const out = as(A, `select public.record_payback('${ACC_A}', 'pay-2', 'Anna', true)`);
    // 60 (bill-1) + 200 (bill-2, " anna " matches) = 260; bill-3 is shared with Luca: left alone.
    assert.match(out, /"settled": \["bill-1", "bill-2"\]/);
    assert.match(out, /"settled_eur": 260/);
    assert.match(out, /"left_eur": 240/);
    assert.match(out, /"linked": true/);
    assert.strictEqual(admin("select string_agg(entry_reference || '=' || owed_settled, ',' order by entry_reference) from public.transactions where user_id = '" + A + "' and credit_debit_indicator = 'DBIT'"), 'bill-1=true,bill-2=true,bill-3=false');
    assert.strictEqual(admin("select flow_type || '/' || flow_source || '/' || payback_contact from public.transactions where entry_reference = 'pay-2'"), 'transfer/user/Anna');
    assert.strictEqual(as(A, 'select payer_key || \'=\' || contact from public.payer_links'), 'anna rossi=Anna');
    // The payment is now out of income.
    assert.strictEqual(as(A, "select flow_type from public.v_transactions_eur where entry_reference = 'pay-2'"), 'transfer');
  });

  await t.test('the next payment from that payer comes back linked; B never sees A\'s link', () => {
    assert.strictEqual(as(A, "select linked_contact from public.payback_candidates(60) where entry_reference = 'pay-1'"), 'Anna', 'ANNA Rossì. keys to anna rossi');
    assert.strictEqual(as(B, "select coalesce(linked_contact, '∅') from public.payback_candidates(60)"), '∅');
    assert.strictEqual(as(B, 'select count(*) from public.payer_links'), '0');
  });

  await t.test('checked payments leave the list and cannot be recorded twice', () => {
    assert.strictEqual(as(A, "select count(*) from public.payback_candidates(60) where entry_reference = 'pay-2'"), '0');
    assert.match(as(A, `select public.record_payback('${ACC_A}', 'pay-2', 'Anna', true)`), /already checked/);
  });

  await t.test('B cannot record, undo or read A\'s payments', () => {
    assert.match(as(B, `select public.record_payback('${ACC_A}', 'pay-1', 'Anna', true)`), /Payment not found/);
    assert.match(as(B, `select public.undo_payback('${ACC_A}', 'pay-2', true)`), /Payment not found/);
    assert.match(as(B, `insert into public.payer_links (user_id, payer_key, contact) values ('${A}', 'x', 'y')`), /row-level security/);
    // B's own Anna bill is untouched by A's payback.
    assert.strictEqual(admin("select owed_settled from public.transactions where entry_reference = 'bill-b'"), 'f');
  });

  await t.test('bad input is refused', () => {
    assert.match(as(A, `select public.record_payback('${ACC_A}', 'pay-1', repeat('x', 101), true)`), /too long/);
    assert.match(as(A, `select public.record_payback(null, 'pay-1', 'Anna', true)`), /Payment not found/);
    assert.match(as(A, `select public.record_payback('${ACC_A}', 'pay-1', null, true)`, { keep: false }), /Contact required/, 'null is not "not a payback"');
    assert.match(as(A, `select public.record_payback('${ACC_A}', 'bill-3', 'Anna', true)`), /Payment not found/, 'a charge is not a payment');
  });

  await t.test('anon cannot call the functions', () => {
    assert.throws(() => psql(dbUrl(), ['-c', 'set role anon; select public.payback_candidates(60)']), /permission denied/);
    assert.throws(() => psql(dbUrl(), ['-c', `set role anon; select public.record_payback('${ACC_A}', 'pay-1', 'Anna', true)`]), /permission denied/);
  });

  await t.test('undo reopens exactly the bills it settled and puts the payment back', () => {
    // A bill settled by hand stays settled.
    admin("update public.transactions set owed_settled = true where entry_reference = 'bill-3'");
    assert.match(as(A, `select public.undo_payback('${ACC_A}', 'pay-2', true)`), /"reopened": 2/);
    assert.strictEqual(admin("select string_agg(entry_reference || '=' || owed_settled, ',' order by entry_reference) from public.transactions where user_id = '" + A + "' and credit_debit_indicator = 'DBIT'"), 'bill-1=false,bill-2=false,bill-3=true');
    assert.strictEqual(admin("select coalesce(flow_type, '∅') || '/' || coalesce(flow_source, '∅') || '/' || coalesce(payback_contact, '∅') from public.transactions where entry_reference = 'pay-2'"), '∅/∅/∅');
    assert.strictEqual(as(A, 'select count(*) from public.payer_links'), '0', 'forgotten');
    assert.match(as(A, `select public.undo_payback('${ACC_A}', 'pay-2', false)`), /Payment not found/, 'nothing left to undo');
  });

  await t.test('"not a payback" hides the payment and unlinks its payer; undo brings it back', () => {
    as(A, "insert into public.payer_links (user_id, payer_key, contact) values ('" + A + "', 'anna rossi', 'Anna'), ('" + A + "', 'someone else', 'Bea')");
    as(A, `select public.record_payback('${ACC_A}', 'pay-1', '', true)`);
    assert.strictEqual(as(A, 'select string_agg(payer_key, \',\') from public.payer_links'), 'someone else', 'only this payer is unlinked');
    as(A, 'delete from public.payer_links');
    assert.strictEqual(admin("select coalesce(flow_type, '∅') || '/' || payback_contact from public.transactions where entry_reference = 'pay-1'"), '∅/');
    assert.strictEqual(as(A, 'select count(*) from public.payer_links'), '0', 'no link for a dismissal');
    assert.strictEqual(as(A, "select count(*) from public.payback_candidates(60) where entry_reference = 'pay-1'"), '0');
    assert.match(as(A, `select public.undo_payback('${ACC_A}', 'pay-1', false)`), /"reopened": 0/);
    assert.strictEqual(as(A, "select count(*) from public.payback_candidates(60) where entry_reference = 'pay-1'"), '1');
  });

  await t.test('a split refund counts against the bill, as on the page, and is settled with it', () => {
    // Bea owes 60 on a bill and got 20 back from a split refund: the page says 40. She pays 40.
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, debtor_name, personal_amount, owed_by)
      values ('sr-bill', '${ACC_A}', '${A}', 100, 'EUR', 'DBIT', '${daysAgo(9)}', 'Shop', null, 40, 'Bea'),
             ('sr-ref', '${ACC_A}', '${A}', 30, 'EUR', 'CRDT', '${daysAgo(8)}', null, 'Shop', 10, 'Bea'),
             ('sr-pay', '${ACC_A}', '${A}', 40, 'EUR', 'CRDT', '${today}', null, 'Bea Verdi', null, null)`);
    try {
      const out = as(A, `select public.record_payback('${ACC_A}', 'sr-pay', 'Bea', false)`);
      assert.match(out, /"settled": \["sr-bill"\]/);
      assert.match(out, /"left_eur": 0/);
      assert.strictEqual(admin("select string_agg(entry_reference || '=' || owed_settled, ',' order by entry_reference) from public.transactions where entry_reference in ('sr-bill', 'sr-ref')"), 'sr-bill=true,sr-ref=true');
      assert.match(as(A, `select public.undo_payback('${ACC_A}', 'sr-pay', false)`), /"reopened": 2/);
      assert.strictEqual(admin("select count(*) from public.transactions where entry_reference in ('sr-bill', 'sr-ref') and not owed_settled"), '2');
      // A refund alone (no bill covered) stays open, and the money is not counted twice.
      admin("update public.transactions set amount = 30 where entry_reference = 'sr-pay'");
      const short = as(A, `select public.record_payback('${ACC_A}', 'sr-pay', 'Bea', false)`, { keep: false });
      assert.match(short, /"settled": \[\]/);
      assert.match(short, /"left_eur": 30/);
    } finally {
      admin("delete from public.transactions where entry_reference like 'sr-%'");
    }
  });

  await t.test('refund credit is never half used: bills settle only when they use it all', () => {
    // Fede: refund -50 (and an older one already settled), bills 10 then 100. The page says 60.
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, debtor_name, personal_amount, owed_by, owed_settled)
      values ('pr-old', '${ACC_A}', '${A}', 80, 'EUR', 'CRDT', '${daysAgo(12)}', null, 'Shop', 0, 'Fede', true),
             ('pr-ref', '${ACC_A}', '${A}', 60, 'EUR', 'CRDT', '${daysAgo(11)}', null, 'Shop', 10, 'Fede', false),
             ('pr-b1', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '${daysAgo(10)}', 'Bar', null, 10, 'Fede', false),
             ('pr-b2', '${ACC_A}', '${A}', 200, 'EUR', 'DBIT', '${daysAgo(9)}', 'Hotel', null, 100, 'Fede', false),
             ('pr-pay', '${ACC_A}', '${A}', 5, 'EUR', 'CRDT', '${today}', null, 'Fede Rosa', null, null, false)`);
    try {
      // 5 + 50 would cover the 10 bill, but only by using 10 of the 50: nothing settles, 5 left.
      const out = as(A, `select public.record_payback('${ACC_A}', 'pr-pay', 'Fede', false)`, { keep: false });
      assert.match(out, /"settled": \[\]/);
      assert.match(out, /"left_eur": 5/);
      // 70 + 50 covers both bills (110) and uses the credit fully: 10 left, refund closed.
      admin("update public.transactions set amount = 70 where entry_reference = 'pr-pay'");
      const full = as(A, `select public.record_payback('${ACC_A}', 'pr-pay', 'Fede', false)`);
      assert.match(full, /"settled": \["pr-b1", "pr-b2"\]/);
      assert.match(full, /"settled_eur": 60/);
      assert.match(full, /"left_eur": 10/);
      assert.strictEqual(admin("select owed_settled from public.transactions where entry_reference = 'pr-ref'"), 't');
    } finally {
      admin("delete from public.transactions where entry_reference like 'pr-%'");
    }
  });

  await t.test('a bill with no euro rate is skipped, not a wall: later bills still settle', () => {
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, debtor_name, personal_amount, owed_by)
      values ('nr-xyz', '${ACC_A}', '${A}', 100, 'XYZ', 'DBIT', '${daysAgo(9)}', 'Abroad', null, 40, 'Ugo'),
             ('nr-eur', '${ACC_A}', '${A}', 50, 'EUR', 'DBIT', '${daysAgo(8)}', 'Bar', null, 25, 'Ugo'),
             ('nr-pay', '${ACC_A}', '${A}', 25, 'EUR', 'CRDT', '${today}', null, 'Ugo Neri', null, null)`);
    try {
      const out = as(A, `select public.record_payback('${ACC_A}', 'nr-pay', 'Ugo', false)`, { keep: false });
      assert.match(out, /"settled": \["nr-eur"\]/);
    } finally {
      admin("delete from public.transactions where entry_reference like 'nr-%'");
    }
  });

  await t.test('a bill naming one person with stray commas is theirs alone, like on the page', () => {
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, debtor_name, personal_amount, owed_by)
      values ('cm-1', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '${daysAgo(9)}', 'Bar', null, 10, 'Carla,'),
             ('cm-2', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '${daysAgo(8)}', 'Bar', null, 10, ' , carla'),
             ('cm-3', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '${daysAgo(7)}', 'Bar', null, 10, 'Carla, Dino'),
             ('cm-pay', '${ACC_A}', '${A}', 30, 'EUR', 'CRDT', '${today}', null, 'Carla Blu', null, null)`);
    try {
      const out = as(A, `select public.record_payback('${ACC_A}', 'cm-pay', 'Carla', false)`, { keep: false });
      assert.match(out, /"settled": \["cm-1", "cm-2"\]/);
      assert.match(out, /"left_eur": 10/);
    } finally {
      admin("delete from public.transactions where entry_reference like 'cm-%'");
    }
  });

  await t.test('only that person\'s own open bills settle: not Splitwise, refunded, transfer, deleted, settled or someone else\'s', () => {
    // Each row is older than the one good bill and alone would be covered by the payment.
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, creditor_name, debtor_name, personal_amount, owed_by, import_batch_id, flow_type, deleted_at, owed_settled)
      values ('fl-sw', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '${daysAgo(20)}', 'Bar', null, 10, 'Eva', gen_random_uuid(), null, null, false),
             ('fl-refunded', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '${daysAgo(19)}', 'Bar', null, 10, 'Eva', null, 'refunded', null, false),
             ('fl-transfer', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '${daysAgo(18)}', 'Bar', null, 10, 'Eva', null, 'transfer', null, false),
             ('fl-deleted', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '${daysAgo(17)}', 'Bar', null, 10, 'Eva', null, null, now(), false),
             ('fl-settled', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '${daysAgo(16)}', 'Bar', null, 10, 'Eva', null, null, null, true),
             ('fl-other', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '${daysAgo(15)}', 'Bar', null, 10, 'Evan', null, null, null, false),
             ('fl-shared', '${ACC_A}', '${A}', 30, 'EUR', 'DBIT', '${daysAgo(14)}', 'Bar', null, 10, 'Eva, Evan', null, null, null, false),
             ('fl-good', '${ACC_A}', '${A}', 20, 'EUR', 'DBIT', '${daysAgo(13)}', 'Bar', null, 10, 'Eva', null, null, null, false),
             ('fl-pay', '${ACC_A}', '${A}', 10, 'EUR', 'CRDT', '${today}', null, 'Eva Gialli', null, null, null, null, null, false)`);
    try {
      const out = as(A, `select public.record_payback('${ACC_A}', 'fl-pay', 'Eva', false)`, { keep: false });
      assert.match(out, /"settled": \["fl-good"\]/);
      assert.match(out, /"left_eur": 0/);
    } finally {
      admin("delete from public.transactions where entry_reference like 'fl-%'");
    }
  });

  await t.test('a payment in a currency without a rate settles nothing', () => {
    admin(`insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date, debtor_name)
           values ('pay-xyz', '${ACC_A}', '${A}', 999, 'XYZ', 'CRDT', '${today}', 'Anna Rossi')`);
    const out = as(A, `select public.record_payback('${ACC_A}', 'pay-xyz', 'Anna', false)`, { keep: false });
    assert.match(out, /"settled": \[\]/);
    assert.match(out, /"left_eur": null/);
  });

  await t.test('rollback removes the new objects; re-apply works', () => {
    applySql(ROLLBACK);
    assert.strictEqual(admin("select count(*) from information_schema.columns where table_name = 'transactions' and column_name in ('payback_contact', 'settled_by_account', 'settled_by_ref')"), '0');
    assert.strictEqual(admin("select count(*) from pg_proc where proname in ('payback_candidates', 'record_payback', 'undo_payback', 'payer_key', 'payer_name_of')"), '0');
    applySql(MIGRATION);
    assert.strictEqual(as(A, 'select count(*) from public.payback_candidates(60)'), '3');
  });
});
