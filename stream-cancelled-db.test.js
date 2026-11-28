// "I cancelled it" (20270123000000_stream_cancelled): stream_action 'cancel' marks a subscription
// cancelled today and 'uncancel' (Undo, Still active) clears it. Real Postgres with every migration
// before it. Needs psql and RLS_TEST_DATABASE_URL; skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const { fullChainDb, skip } = require('./full-chain-db');

const NAME = '20270123000000_stream_cancelled';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

test('a subscription can be marked cancelled and back', { skip }, async (t) => {
  const db = fullChainDb('stream_cancelled', { upTo: NAME });
  t.after(db.drop);
  db.admin(`insert into auth.users (id) values ('${A}'), ('${B}');
    insert into public.recurring_streams (user_id, stream_key, merchant_key, currency, display_name, detected_status, user_status, source)
    values ('${A}', 'gym', 'gym', 'EUR', 'Gym', 'active', 'confirmed', 'bank'),
           ('${B}', 'other', 'other', 'EUR', 'Theirs', 'active', null, 'bank')`);
  db.applySql(`supabase/migrations/${NAME}.sql`);
  const act = (sub, key, action) =>
    db.as(sub, `select public.stream_action((select id from public.recurring_streams where stream_key = '${key}'), '${action}')`);
  const cancelled = (key) => db.admin(`select coalesce(cancelled_on::text, '-') from public.recurring_streams where stream_key = '${key}'`);
  const today = db.admin('select current_date::text');

  await t.test('cancel sets today, and keeps the status', () => {
    act(A, 'gym', 'cancel');
    assert.strictEqual(cancelled('gym'), today);
    assert.strictEqual(db.admin(`select user_status from public.recurring_streams where stream_key = 'gym'`), 'confirmed');
  });

  await t.test('uncancel clears it', () => {
    act(A, 'gym', 'uncancel');
    assert.strictEqual(cancelled('gym'), '-');
  });

  await t.test("someone else's stream is refused", () => {
    assert.match(act(A, 'other', 'cancel'), /Stream not found/);
    assert.strictEqual(cancelled('other'), '-');
  });

  await t.test('the older actions still work', () => {
    act(A, 'gym', 'dismiss');
    act(A, 'gym', 'undismiss');
    assert.strictEqual(db.admin(`select user_status from public.recurring_streams where stream_key = 'gym'`), 'confirmed');
  });

  await t.test('re-runnable, still definer with an empty search_path, not for anon', () => {
    db.applySql(`supabase/migrations/${NAME}.sql`);
    assert.strictEqual(db.admin(`select prosecdef || ' ' || array_to_string(proconfig, ',') from pg_proc where proname = 'stream_action'`), 'true search_path=""');
    assert.strictEqual(db.admin(`select has_function_privilege('anon', 'public.stream_action(uuid, text, jsonb)', 'execute')`), 'f');
  });

  await t.test('rollback drops the column and the new actions', () => {
    db.applySql(`supabase/rollbacks/${NAME}.down.sql`);
    assert.strictEqual(db.admin(`select count(*) from pg_attribute where attrelid = 'public.recurring_streams'::regclass and attname = 'cancelled_on'`), '0');
    assert.match(act(A, 'gym', 'cancel'), /Unknown stream action/);
  });
});
