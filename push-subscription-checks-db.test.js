// H237: claim_push_subscription checks the endpoint and keys, but a direct insert (still allowed,
// for older dashboards) skipped those checks, so a user could make the notify job POST to any URL.
// 20270118000000_push_subscription_checks puts the same rules on the table, and both refuse a host
// that can't be a push service: an IP literal, localhost, or a name without a dot. (A DNS name that
// resolves to a private address still passes: the check can't see DNS.)
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
    assert.doesNotMatch(insert('https://192.168.1.1/admin'), /ERROR/);
    assert.doesNotMatch(insert('https://localhost/x'), /ERROR/);
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

  await t.test('hosts that are no push service are refused', () => {
    for (const ep of [
      'https://192.168.1.1/x', 'https://10.0.0.1:443/x', 'https://169.254.169.254/latest', 'https://127.1/x',
      'https://0x7f.0.0.1/x', 'https://2130706433/x', 'https://10.0.0.1./x', 'https://[::1]/x', 'https://[fd00::1]:8443/x',
      'https://localhost/x', 'https://LOCALHOST./x', 'https://api.localhost/x', 'https://router/x', 'https://router:8443/x',
      'https://user@push.example.com/x', 'https://push.example.com@10.0.0.1/x', 'https://%31%30.0.0.1/x', 'https://push.example.com\\@10.0.0.1/x',
      'https:///x', 'https://:443/x',
    ]) assert.match(insert(ep), /push_subscriptions_valid/, ep);
    // Real push services, with and without a port.
    for (const ep of [
      'https://fcm.googleapis.com/fcm/send/a1', 'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://web.push.apple.com/QH9x', 'https://wns2-par02p.notify.windows.com/w/?token=AwY', 'https://push.example.com:8443/k',
    ]) assert.doesNotMatch(insert(ep), /ERROR/, ep);
  });

  await t.test('the claim RPC refuses the same hosts', () => {
    assert.match(as(A, `select public.claim_push_subscription('https://192.168.1.1/x', 'k', 'a')`), /push_subscriptions_valid/);
    assert.match(as(A, `select public.claim_push_subscription('https://[::1]/x', 'k', 'a')`), /push_subscriptions_valid/);
  });

  await t.test('the claim RPC still works', () => {
    assert.doesNotMatch(as(A, `select public.claim_push_subscription('${EP}', 'newKey', 'newAuth')`), /ERROR/);
    assert.strictEqual(admin(`select p256dh from public.push_subscriptions where endpoint = '${EP}'`), 'newKey');
  });

  await t.test('the rollback drops the check', () => {
    applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.doesNotMatch(insert('http://192.168.1.1/again'), /ERROR/);
    assert.doesNotMatch(insert('https://10.0.0.9/again'), /ERROR/);
    assert.strictEqual(admin(`select count(*) from pg_proc where proname = 'push_endpoint_ok'`), '0');
  });
});
