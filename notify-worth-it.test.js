const test = require('node:test');
const assert = require('node:assert');
const { buildPayload, fetchEligibleTransactions } = require('./notify-worth-it');

// Records every builder call as [method, ...args]; awaiting it resolves { data: [], error: null }.
function fakeSupabase() {
  const calls = [];
  const builder = new Proxy({}, {
    get: (_, method) => {
      if (method === 'then') return (resolve) => resolve({ data: [], error: null });
      return (...args) => {
        calls.push([method, ...args]);
        return builder;
      };
    },
  });
  return { supabase: builder, calls };
}

const NOW = new Date('2026-10-27T12:00:00Z');

test('keeps the created_at 3h-24h window', async () => {
  const { supabase, calls } = fakeSupabase();

  await fetchEligibleTransactions(supabase, 'user', NOW);

  assert.deepStrictEqual(calls.find((c) => c[0] === 'lte' && c[1] === 'created_at'), ['lte', 'created_at', '2026-10-27T09:00:00.000Z']);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'gte' && c[1] === 'created_at'), ['gte', 'created_at', '2026-10-26T12:00:00.000Z']);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'eq' && c[1] === 'user_id'), ['eq', 'user_id', 'user']);
});

test('floors booking_date at now - 7 days, null booking_date still passes', async () => {
  const { supabase, calls } = fakeSupabase();

  await fetchEligibleTransactions(supabase, 'user', NOW);

  assert.deepStrictEqual(calls.find((c) => c[0] === 'or'), ['or', 'booking_date.gte.2026-10-20,booking_date.is.null']);
});

test('booking-date floor uses the UTC date', async () => {
  const { supabase, calls } = fakeSupabase();

  await fetchEligibleTransactions(supabase, 'user', new Date('2026-10-27T23:30:00-05:00'));

  assert.deepStrictEqual(calls.find((c) => c[0] === 'or'), ['or', 'booking_date.gte.2026-10-21,booking_date.is.null']);
});

const { userIdsWithSubscriptions, notifyUser } = require('./notify-worth-it');

// Regression: prompts went only to USER_ID; other users with notifications on never got any.
test('every user with a push subscription is prompted, each once', async () => {
  const supabase = {
    from: () => ({
      select: async () => ({ data: [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'a' }], error: null }),
    }),
  };
  assert.deepStrictEqual(await userIdsWithSubscriptions(supabase), ['a', 'b']);
});

test('a user with nothing to prompt sends nothing', async () => {
  const sent = [];
  const supabase = {
    from: () => {
      const q = {
        select: () => q, eq: () => q, gte: () => q, is: () => q, or: () => q, in: () => q, not: () => q,
        neq: () => q, lt: () => q, lte: () => q, gt: () => q, order: () => q, limit: () => q,
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return q;
    },
  };
  const push = { fetchSubscriptions: async () => [{}], sendToAllSubscriptions: async () => sent.push(1) };
  assert.strictEqual(await notifyUser(supabase, 'a', push), 0);
  assert.deepStrictEqual(sent, []);
});

// Regression: refunded or deleted charges still got a "worth it?" prompt.
test('refunded, deleted and transfer rows are not prompted', async () => {
  const rows = [
    { entry_reference: 'ok', amount: 20, flow_type: 'spend', deleted_at: null },
    { entry_reference: 'new', amount: 20, flow_type: null, deleted_at: null },
    { entry_reference: 'refunded', flow_type: 'refunded', deleted_at: null },
    { entry_reference: 'deleted', flow_type: 'spend', deleted_at: '2026-10-27T10:00:00Z' },
    { entry_reference: 'transfer', flow_type: 'transfer', deleted_at: null },
  ];
  const builder = new Proxy({}, {
    get: (_, m) => (m === 'then' ? (resolve) => resolve({ data: rows, error: null }) : () => builder),
  });
  const got = await fetchEligibleTransactions(builder, 'user', NOW);
  assert.deepStrictEqual(got.map((t) => t.entry_reference), ['ok', 'new']);
});

// Polish 1 #2: the Docker/cron job must weigh only my share, like the edge function and the app.
// protects=a charge paid for others (or mostly) is not prompted, and the push shows my share
test('a split charge is prompted on my share only', async () => {
  const rows = [
    { entry_reference: 'mine', amount: 40, personal_amount: null, flow_type: 'spend', deleted_at: null },
    { entry_reference: 'half', amount: 40, personal_amount: 20, flow_type: 'spend', deleted_at: null },
    { entry_reference: 'small', amount: 40, personal_amount: 10, flow_type: 'spend', deleted_at: null },
    { entry_reference: 'others', amount: 40, personal_amount: 0, flow_type: 'spend', deleted_at: null },
  ];
  const builder = new Proxy({}, {
    get: (_, m) => (m === 'then' ? (resolve) => resolve({ data: rows, error: null }) : () => builder),
  });
  const got = await fetchEligibleTransactions(builder, 'user', NOW);
  assert.deepStrictEqual(got.map((t) => t.entry_reference), ['mine', 'half']);
  const body = buildPayload([{ entry_reference: 'half', creditor_name: 'Pizza', amount: 40, personal_amount: 20, currency: 'EUR', category: 'Dine Out' }]).body;
  assert.strictEqual(body, '€20.00 at Pizza — Dine Out');
  // Polish 1 #10: a code Intl doesn't know keeps the plain form.
  const odd = buildPayload([{ entry_reference: 'x', creditor_name: 'Shop', amount: 12.5, personal_amount: null, currency: 'XX1', category: 'Shopping' }]).body;
  assert.strictEqual(odd, '12.5 XX1 at Shop — Shopping');
  // Polish 5 #6: the app formats in en-GB by default, where dollars read "US$".
  const usd = buildPayload([{ entry_reference: 'u', creditor_name: 'Shop', amount: 50, personal_amount: null, currency: 'USD', category: 'Shopping' }]).body;
  assert.strictEqual(usd, 'US$50.00 at Shop — Shopping');
});

// protects=the push names the shop like the app does; fails_when=the bank's raw text with codes
// ("Amazon Mark* E46na7fw3") reaches the lock screen, or the user's own name for it is ignored
test('the push shows the clean merchant name, or the name the user gave it', () => {
  const tx = (creditor_name, custom_name = null) => ({ entry_reference: 'r1', creditor_name, custom_name, amount: 43.03, currency: 'USD', category: 'Shopping' });
  assert.strictEqual(buildPayload([tx('Amazon Mark* E46na7fw3')]).body, 'US$43.03 at Amazon — Shopping');
  assert.strictEqual(buildPayload([tx('Amazon Mark* E46na7fw3', 'Birthday gift')]).body, 'US$43.03 at Birthday gift — Shopping');
  assert.strictEqual(buildPayload([tx(null)]).body, 'US$43.03 at a merchant — Shopping');
  assert.strictEqual(buildPayload([tx('   ', '  ')]).body, 'US$43.03 at a merchant — Shopping');
  assert.strictEqual(
    buildPayload([tx('Tst*zuckers Bagels & S'), tx('PAYPAL *SPOTIFY'), tx(''), tx('X')]).body,
    '4 purchases today: Zuckers Bagels, SPOTIFY, a merchant +1 more',
  );
});
