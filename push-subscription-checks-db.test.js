// H237: claim_push_subscription checks the endpoint and keys, but a direct insert (still allowed,
// for older dashboards) skipped those checks, so a user could make the notify job POST to any URL.
// 20270118000000_push_subscription_checks puts the same rules on the table.
// Real Postgres, every migration. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270118000000_push_subscription_checks';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const EP = 'https://fcm.googleapis.com/fcm/send/abc';

test('push subscription checks', { skip }, async (t) => {
  const { admin, as, applySql, drop } = fullChainDb('push_checks', { upTo: NAME });
  t.after(drop);
  admin(`insert into auth.users (id) values ('${A}')`);
  const insert = (endpoint, p256dh = 'BKey_-1=', auth = 'aUth-_') => as(A,
    `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${A}', '${endpoint}', '${p256dh}', '${auth}')`);
  const endpoints = () => admin(`select string_agg(endpoint, ',' order by endpoint) from public.push_subscriptions`);

  await t.test('before: a direct insert takes a LAN address', () => {
    assert.doesNotMatch(insert('http://192.168.1.1/admin'), /ERROR/);
    assert.doesNotMatch(insert(EP), /ERROR/);
    assert.doesNotMatch(insert('https://push.example.com/big', 'x'.repeat(5000)), /ERROR/);
  });

  await t.test('rows that could never get a push are removed; good ones stay', () => {
    applySql(`supabase/migrations/${NAME}.sql`);
    applySql(`supabase/migrations/${NAME}.sql`); // twice: safe to re-run
    assert.strictEqual(endpoints(), EP);
    assert.strictEqual(admin(`select convalidated from pg_constraint where conname = 'push_subscriptions_valid'`), 't');
  });

  await t.test('direct inserts follow the same rules as claim_push_subscription', () => {
    assert.match(insert('http://10.0.0.1/x'), /push_subscriptions_valid/);
    assert.match(insert(`https://push.example.com/${'a'.repeat(2048)}`), /push_subscriptions_valid/);
    assert.match(insert('https://push.example.com/k', 'not base64!'), /push_subscriptions_valid/);
    assert.match(insert('https://push.example.com/a', 'ok', 'a'.repeat(257)), /push_subscriptions_valid/);
    assert.doesNotMatch(insert('https://push.example.com/fine'), /ERROR/);
  });

  await t.test('the claim RPC still works', () => {
    assert.doesNotMatch(as(A, `select public.claim_push_subscription('${EP}', 'newKey', 'newAuth')`), /ERROR/);
    assert.strictEqual(admin(`select p256dh from public.push_subscriptions where endpoint = '${EP}'`), 'newKey');
  });

  await t.test('the rollback drops the check', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.doesNotMatch(insert('http://192.168.1.1/again'), /ERROR/);
  });
});
