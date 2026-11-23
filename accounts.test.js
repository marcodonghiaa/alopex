const test = require('node:test');
const assert = require('node:assert');
const { getAccounts, getAllUserIds, ebAccountId, idsPatchFromDetails, accountType, pickBalance } = require('./accounts');

test('ebAccountId uses eb_account_uid when set', () => {
  assert.strictEqual(ebAccountId({ uid: 'a', eb_account_uid: 'b' }), 'b');
});

test('ebAccountId falls back to uid', () => {
  assert.strictEqual(ebAccountId({ uid: 'a', eb_account_uid: null }), 'a');
  assert.strictEqual(ebAccountId({ uid: 'a' }), 'a');
});

test('idsPatchFromDetails takes hash and iban', () => {
  assert.deepStrictEqual(
    idsPatchFromDetails({ identification_hash: 'h', account_id: { iban: 'IT1' } }),
    { identification_hash: 'h', iban: 'IT1' },
  );
});

test('idsPatchFromDetails takes hash alone when no iban', () => {
  assert.deepStrictEqual(idsPatchFromDetails({ identification_hash: 'h', account_id: {} }), { identification_hash: 'h' });
});

test('idsPatchFromDetails returns null without a hash', () => {
  assert.strictEqual(idsPatchFromDetails({ account_id: { iban: 'IT1' } }), null);
});

test('getAccounts selects the id columns', async () => {
  let selected;
  const supabase = {
    from: () => ({
      select: (cols) => {
        selected = cols;
        return { eq: async () => ({ data: [{ uid: 'a' }], error: null }) };
      },
    }),
  };
  await getAccounts(supabase, 'user');
  for (const col of ['eb_account_uid', 'identification_hash', 'iban', 'consent_valid_until']) assert.ok(selected.includes(col), col);
});

test('getAccounts reads without eb_account_uid when the column is missing', async () => {
  const selects = [];
  const responses = [
    { data: null, error: { code: '42703' } },
    { data: null, error: { code: '42703' } },
    { data: null, error: { code: '42703' } },
    { data: [{ uid: 'a' }], error: null },
  ];
  const supabase = {
    from: () => ({
      select: (cols) => {
        selects.push(cols);
        const response = responses[selects.length - 1];
        return { eq: async () => response };
      },
    }),
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepStrictEqual(await getAccounts(supabase, 'user'), [{ uid: 'a' }]);
  } finally {
    console.warn = warn;
  }
  assert.strictEqual(selects.length, 4);
  assert.ok(selects[0].includes('account_type'));
  assert.ok(!selects[3].includes('eb_account_uid'));
});

function accountsClient(rows) {
  return {
    from: () => ({
      select: () => {
        const result = Promise.resolve({ data: rows, error: null });
        result.eq = async () => ({ data: rows, error: null });
        return result;
      },
    }),
  };
}

test('getAccounts skips manual accounts: they have no bank to sync', async () => {
  const supabase = accountsClient([{ uid: 'bank' }, { uid: 'cash', manual: true }]);
  assert.deepStrictEqual(await getAccounts(supabase, 'user'), [{ uid: 'bank' }]);
});

test('getAccounts reads manual when the eb column exists but manual does not', async () => {
  const selects = [];
  const responses = [
    { data: null, error: { code: '42703' } },
    { data: null, error: { code: '42703' } },
    { data: [{ uid: 'a', eb_account_uid: null }], error: null },
  ];
  const supabase = {
    from: () => ({
      select: (cols) => {
        selects.push(cols);
        return { eq: async () => responses[selects.length - 1] };
      },
    }),
  };
  assert.deepStrictEqual(await getAccounts(supabase, 'user'), [{ uid: 'a', eb_account_uid: null }]);
  assert.ok(selects[0].includes('manual'));
  assert.ok(selects[2].includes('eb_account_uid') && !selects[2].includes('manual'));
});

test('getAllUserIds leaves out users with only manual accounts', async () => {
  const supabase = accountsClient([
    { user_id: 'u1', manual: false },
    { user_id: 'u2', manual: true },
  ]);
  assert.deepStrictEqual(await getAllUserIds(supabase), ['u1']);
});

test('accountType maps ISO 20022 cash account types', () => {
  assert.deepStrictEqual(['CACC', 'SVGS', 'CARD', 'LOAN', 'TRAN'].map(accountType), ['checking', 'savings', 'credit_card', 'loan', 'other']);
  assert.strictEqual(accountType(undefined), null);
  assert.strictEqual(accountType(''), null);
});

// H003: banks list several balance types in their own order; the booked one is the balance.
const bal = (balance_type, amount) => ({ balance_type, balance_amount: { amount, currency: 'EUR' } });

test('pickBalance prefers the booked balance over an available one listed first', () => {
  assert.strictEqual(pickBalance([bal('ITAV', '1500'), bal('CLBD', '500')]).balance_type, 'CLBD');
  assert.strictEqual(pickBalance([bal('CLAV', '1500'), bal('XPCD', '480'), bal('ITBD', '490')]).balance_type, 'ITBD');
  assert.strictEqual(pickBalance([bal('ITAV', '1500'), bal('OPBD', '470')]).balance_type, 'OPBD');
  assert.strictEqual(pickBalance([bal('CLAV', '1500'), bal('ITAV', '1400')]).balance_type, 'ITAV');
});

test('pickBalance falls back to the first entry when no type is known, and to undefined when empty', () => {
  assert.strictEqual(pickBalance([bal('XXXX', '1'), bal('YYYY', '2')]).balance_amount.amount, '1');
  assert.strictEqual(pickBalance([{ balance_amount: { amount: '3', currency: 'EUR' } }]).balance_amount.amount, '3');
  assert.strictEqual(pickBalance([]), undefined);
  assert.strictEqual(pickBalance(undefined), undefined);
});
