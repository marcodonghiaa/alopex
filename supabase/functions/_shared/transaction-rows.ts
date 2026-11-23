// Enable Banking transactions -> rows of public.transactions.
// The derived entry_reference must stay byte-identical to what is already stored (same key, SHA-1,
// as the old Node sync made it), or every stored reference-less transaction would be inserted twice.

import { normalizeMerchant } from "./merchant-key.ts";

type Json = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
export type EbTransaction = Record<string, any>;

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Primary key is (account_uid, entry_reference), but banks may omit entry_reference.
// A null key, or the same key twice in one upsert, makes Postgres reject the whole
// batch. Derive a stable id for null refs; identical same-day twins get an occurrence
// suffix. ponytail: suffix depends on fetch order, fine while banks return a stable order.
async function entryReferenceFor(tx: EbTransaction, seen: Map<string, number>): Promise<string> {
  if (tx.entry_reference) return tx.entry_reference;
  const key = [
    tx.booking_date, tx.value_date, tx.transaction_amount?.amount, tx.transaction_amount?.currency,
    tx.credit_debit_indicator, tx.creditor?.name, tx.debtor?.name, (tx.remittance_information || []).join(" "),
  ].join("|");
  const n = seen.get(key) || 0;
  seen.set(key, n + 1);
  return `h:${(await sha1Hex(`${key}|${n}`)).slice(0, 24)}`;
}

// Some banks reuse one entry_reference for different transactions (Enable Banking FAQ), and the
// upsert on (account_uid, entry_reference) then kept only one of them. A key never changes once
// stored, so nothing stored before is duplicated: the bank ref stays the key of the row stored under
// it, and another transaction with that ref is keyed `ref#<hash of date, amount, currency, side>`,
// the same on every sync. Which is which comes from the stored rows (their bank payload, raw), read
// by the caller for lookupKeys(transactions) and passed to buildRows as `stored`.
export type StoredRefs = Map<string, string | null>; // key -> content (contentOf), null when unknown

const contentOf = (tx: EbTransaction) =>
  [tx.booking_date, tx.transaction_amount?.amount, tx.transaction_amount?.currency, tx.credit_debit_indicator].join("|");
const splitKey = async (ref: string, content: string) => `${ref}#${(await sha1Hex(content)).slice(0, 12)}`;

// What a stored row was saved from, from its raw column; null when there is no bank payload.
export const storedContent = (raw: unknown): string | null =>
  raw && typeof raw === "object" && (raw as EbTransaction).transaction_amount ? contentOf(raw as EbTransaction) : null;

// Every key a bank-ref transaction of this batch could have: read those rows before buildRows.
export async function lookupKeys(transactions: EbTransaction[]): Promise<string[]> {
  const keys = new Set<string>();
  for (const tx of transactions) {
    if (tx.status === "PDNG" || !tx.entry_reference) continue;
    keys.add(tx.entry_reference).add(await splitKey(tx.entry_reference, contentOf(tx)));
  }
  return [...keys];
}

// The key for a transaction that has a bank ref. bareTaken: ref -> the content that got the bare
// ref in this batch, so two rows never share it.
async function bankKey(
  tx: EbTransaction,
  stored: StoredRefs,
  inBatch: Map<string, Set<string>>,
  windowStart: string,
  bareTaken: Map<string, string>,
): Promise<string> {
  const ref: string = tx.entry_reference;
  const content = contentOf(tx);
  const split = await splitKey(ref, content);
  if (stored.has(split)) return split;
  const was = stored.get(ref);
  if (was === null || was === content) return ref;
  if (was !== undefined) {
    // The bare ref holds another transaction. If that one is in this batch too, or older than the
    // window this sync asked for, this is a new transaction reusing the ref. Otherwise the bank
    // changed that row: update it, as before.
    // Known limit: a row stored under a split key that the bank then changes (a reused ref AND a
    // new amount or date) gets a new split key, so it is stored a second time.
    const wasDate = was.split("|")[0];
    if (inBatch.get(ref)!.has(was) || (wasDate && wasDate < windowStart)) return split;
  }
  if (!bareTaken.has(ref)) bareTaken.set(ref, content);
  return bareTaken.get(ref) === content ? ref : split;
}

// The bank payload is kept for support and export, minus the counterparty's account number
// (IBAN): nothing reads it, and it is someone else's data.
export function rawWithoutAccounts(tx: EbTransaction): EbTransaction {
  const { creditor_account: _c, debtor_account: _d, ...rest } = tx;
  return rest;
}

// Uppercase, no spaces: how IBANs are compared.
export const normalizeIban = (iban: unknown) => (typeof iban === "string" ? iban.replace(/\s+/g, "").toUpperCase() : "");

// Whether the other side of the transaction is one of the user's own accounts: true or false
// when the bank sent the counterparty's IBAN, null when it didn't (or ownIbans is unknown).
export function ownCounterparty(tx: EbTransaction, ownIbans?: Set<string>): boolean | null {
  const other = normalizeIban(tx.credit_debit_indicator === "DBIT" ? tx.creditor_account?.iban : tx.debtor_account?.iban);
  if (!other || !ownIbans) return null;
  return ownIbans.has(other);
}

function mapToRow(tx: EbTransaction, accountUid: string, userId: string, entryReference: string, ownIbans?: Set<string>): Json {
  const creditorName = (tx.credit_debit_indicator === "CRDT" && tx.debtor?.name) || tx.creditor?.name || null;
  return {
    entry_reference: entryReference,
    account_uid: accountUid,
    amount: parseFloat(tx.transaction_amount.amount),
    currency: tx.transaction_amount.currency,
    credit_debit_indicator: tx.credit_debit_indicator,
    // The dashboard shows creditor_name as the row's name, so for money coming in it is the payer.
    creditor_name: creditorName,
    merchant_key: normalizeMerchant(creditorName).key,
    debtor_name: tx.debtor?.name || null,
    remittance_info: (tx.remittance_information || []).join(" "),
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
// no own_counterparty. stored: the rows already saved under lookupKeys(transactions). dateFrom:
// the date_from the bank was asked for, null for its longest history.
export async function buildRows(
  transactions: EbTransaction[],
  accountUid: string,
  userId: string,
  ownIbans?: Set<string>,
  stored: StoredRefs = new Map(),
  dateFrom: string | null = null,
): Promise<Json[]> {
  const seen = new Map<string, number>();
  const byRef = new Map<string, Json>(); // one row per key, last wins
  // Pending rows wait until booked: their id changes when booked, so they would count twice.
  const booked = transactions.filter((tx) => tx.status !== "PDNG");
  const inBatch = new Map<string, Set<string>>();
  for (const tx of booked) if (tx.entry_reference) inBatch.set(tx.entry_reference, (inBatch.get(tx.entry_reference) ?? new Set()).add(contentOf(tx)));
  const earliest = booked.map((tx) => tx.booking_date).filter(Boolean).sort()[0] ?? "";
  const windowStart = dateFrom && dateFrom < earliest ? dateFrom : earliest;
  const bareTaken = new Map<string, string>();
  for (const tx of booked) {
    const ref = tx.entry_reference ? await bankKey(tx, stored, inBatch, windowStart, bareTaken) : await entryReferenceFor(tx, seen);
    byRef.set(ref, mapToRow(tx, accountUid, userId, ref, ownIbans));
  }
  return [...byRef.values()];
}
