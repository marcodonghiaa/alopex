const crypto = require('crypto');

// Primary key is (account_uid, entry_reference), but banks may omit entry_reference.
// A null key, or the same key twice in one upsert, makes Postgres reject the whole
// batch -- the account then silently stops syncing. Derive a stable id for null
// refs; keep one row per key. Identical same-day twins (same fields) get an
// occurrence suffix. ponytail: suffix depends on fetch order, fine while banks
// return a stable order; switch to a bank-provided id if one appears.
function entryReferenceFor(tx, seen) {
  if (tx.entry_reference) return tx.entry_reference;
  const key = [
    tx.booking_date, tx.value_date, tx.transaction_amount?.amount, tx.transaction_amount?.currency,
    tx.credit_debit_indicator, tx.creditor?.name, tx.debtor?.name, (tx.remittance_information || []).join(' '),
  ].join('|');
  const n = seen.get(key) || 0;
  seen.set(key, n + 1);
  return `h:${crypto.createHash('sha1').update(`${key}|${n}`).digest('hex').slice(0, 24)}`;
}

// Some banks reuse one entry_reference for different transactions (Enable Banking FAQ), and the
// upsert on (account_uid, entry_reference) then kept only one of them. A key never changes once
// stored, so nothing stored before is duplicated: the bank ref stays the key of the row stored under
// it, and another transaction with that ref is keyed `ref#<hash of date, amount, currency, side>`,
// the same on every sync. Which is which comes from the stored rows (their bank payload, raw), read
// by the caller for lookupKeys(transactions) and passed to buildRows as `stored` (key -> content,
// null when unknown). Same keys as supabase/functions/_shared/transaction-rows.ts.
const contentOf = (tx) =>
  [tx.booking_date, tx.transaction_amount?.amount, tx.transaction_amount?.currency, tx.credit_debit_indicator].join('|');
const splitKey = (ref, content) => `${ref}#${crypto.createHash('sha1').update(content).digest('hex').slice(0, 12)}`;

// What a stored row was saved from, from its raw column; null when there is no bank payload.
const storedContent = (raw) => (raw && typeof raw === 'object' && raw.transaction_amount ? contentOf(raw) : null);

// Every key a bank-ref transaction of this batch could have: read those rows before buildRows.
function lookupKeys(transactions) {
  const keys = new Set();
  for (const tx of transactions) {
    if (tx.status === 'PDNG' || !tx.entry_reference) continue;
    keys.add(tx.entry_reference).add(splitKey(tx.entry_reference, contentOf(tx)));
  }
  return [...keys];
}

// The key for a transaction that has a bank ref. bareTaken: ref -> the content that got the bare
// ref in this batch, so two rows never share it.
function bankKey(tx, stored, inBatch, earliest, bareTaken) {
  const ref = tx.entry_reference;
  const content = contentOf(tx);
  const split = splitKey(ref, content);
  if (stored.has(split)) return split;
  const was = stored.get(ref);
  if (was === null || was === content) return ref;
  if (was !== undefined) {
    // The bare ref holds another transaction. If that one is in this batch too, or older than all
    // of it, this is a new transaction reusing the ref. Otherwise the bank changed that row: update
    // it, as before.
    const wasDate = was.split('|')[0];
    if (inBatch.get(ref).has(was) || (wasDate && wasDate < earliest)) return split;
  }
  if (!bareTaken.has(ref)) bareTaken.set(ref, content);
  return bareTaken.get(ref) === content ? ref : split;
}

// The bank payload is kept for support and export, minus the counterparty's account number
// (IBAN): nothing reads it, and it is someone else's data.
function rawWithoutAccounts(tx) {
  const { creditor_account: _c, debtor_account: _d, ...rest } = tx;
  return rest;
}

// Uppercase, no spaces: how IBANs are compared.
const normalizeIban = (iban) => (typeof iban === 'string' ? iban.replace(/\s+/g, '').toUpperCase() : '');

// Whether the other side of the transaction is one of the user's own accounts: true or false
// when the bank sent the counterparty's IBAN, null when it didn't (or ownIbans is unknown).
function ownCounterparty(tx, ownIbans) {
  const other = normalizeIban(tx.credit_debit_indicator === 'DBIT' ? tx.creditor_account?.iban : tx.debtor_account?.iban);
  if (!other || !ownIbans) return null;
  return ownIbans.has(other);
}

function mapToRow(tx, accountUid, userId, entryReference, ownIbans) {
  return {
    entry_reference: entryReference,
    account_uid: accountUid,
    amount: parseFloat(tx.transaction_amount.amount),
    currency: tx.transaction_amount.currency,
    credit_debit_indicator: tx.credit_debit_indicator,
    // The dashboard shows creditor_name as the row's name, so for money coming in it is the payer.
    creditor_name: (tx.credit_debit_indicator === 'CRDT' && tx.debtor?.name) || tx.creditor?.name || null,
    debtor_name: tx.debtor?.name || null,
    remittance_info: (tx.remittance_information || []).join(' '),
    booking_date: tx.booking_date,
    value_date: tx.value_date,
    bank_transaction_code: tx.bank_transaction_code?.code || null,
    // Left out when the user's IBANs are unknown, so a failed read keeps what was stored.
    ...(ownIbans && { own_counterparty: ownCounterparty(tx, ownIbans) }),
    raw: rawWithoutAccounts(tx),
    user_id: userId,
  };
}

// ownIbans: the user's own accounts' IBANs, normalized (see normalizeIban); without it rows carry
// no own_counterparty.
function buildRows(transactions, accountUid, userId, ownIbans, stored = new Map()) {
  const seen = new Map();
  const byRef = new Map(); // Map keeps one row per key, last wins
  // A pending transaction has no stable id yet: stored now, it would be kept beside its
  // booked copy (a different id) and counted twice. It is stored once the bank books it.
  const booked = transactions.filter((tx) => tx.status !== 'PDNG');
  const inBatch = new Map();
  for (const tx of booked) if (tx.entry_reference) inBatch.set(tx.entry_reference, (inBatch.get(tx.entry_reference) ?? new Set()).add(contentOf(tx)));
  const earliest = booked.map((tx) => tx.booking_date).filter(Boolean).sort()[0] ?? '';
  const bareTaken = new Map();
  for (const tx of booked) {
    const ref = tx.entry_reference ? bankKey(tx, stored, inBatch, earliest, bareTaken) : entryReferenceFor(tx, seen);
    byRef.set(ref, mapToRow(tx, accountUid, userId, ref, ownIbans));
  }
  return [...byRef.values()];
}

module.exports = { buildRows, normalizeIban, lookupKeys, storedContent };
