// Deno port of sync-transactions.js + sync-networth.js for ONE account, used by sync-bank.
// Kept free of Deno.env so the tests run with fakes: fetch and supabase come in as deps.

import { buildRows, type EbTransaction, normalizeIban } from "./transaction-rows.ts";
import { errorTag } from "./log-safe.ts";
import { accountType } from "./account-match.ts";

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };
export type Deps = { fetch: typeof fetch; supabase: Db };

export interface SyncAccount {
  uid: string;
  user_id: string;
  eb_account_uid?: string | null;
  identification_hash?: string | null;
  consent_valid_until?: string | null;
  account_type?: string | null;
  sync_error?: string | null;
}

export const ACCOUNT_COLUMNS = "uid, user_id, eb_account_uid, identification_hash, consent_valid_until, account_type, sync_error";

// The accounts patch that records this run's outcome for the dashboard: the error code and when
// it was first seen, or both cleared once a run succeeds. null when nothing changed.
export function syncErrorPatch(account: SyncAccount, error: string | null, nowIso: string) {
  if ((account.sync_error ?? null) === error) return null;
  return { sync_error: error, sync_error_at: error ? nowIso : null };
}

// sync-bank's reply status, which pg_net keeps in net._http_response: 429 when the bank's daily
// limit for unattended fetches (often 4) is reached, which the next run retries, 502 otherwise.
export function syncStatus(cursor: string | null, error: string | null): number {
  if (cursor && !error) return 200;
  return error === "ASPSP_RATE_LIMIT_EXCEEDED" ? 429 : 502;
}

const EB = "https://api.enablebanking.com/accounts";
const OVERLAP_DAYS = 7;
const FALLBACK_FIRST_SYNC_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;

// Statuses with which EB refuses an account id (dead or expired consent).
const EB_REJECTED_STATUSES = new Set([401, 403, 404, 422]);

type EbError = Error & { status?: number; code?: string };

export { errorTag };

// The id Enable Banking answers to now: a renewed consent can give the same bank
// account a new id (eb_account_uid); null means uid is still it.
const ebAccountId = (account: SyncAccount) => account.eb_account_uid || account.uid;

const rejectedStatus = (err: EbError) => (err.status && EB_REJECTED_STATUSES.has(err.status) ? err.status : null);

// What went wrong, as stored on accounts.sync_error for the dashboard: EB's error name when the
// bank answered with one (e.g. ASPSP_RATE_LIMIT_EXCEEDED), else the HTTP status, a timeout
// (the sync's deadline) or a network failure.
export function syncErrorCode(err: unknown): string {
  const e = err as EbError;
  if (typeof e?.code === "string") return e.code;
  if (e?.status) return `HTTP_${e.status}`;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "TIMEOUT";
  return "NETWORK";
}

// The bank ended the consent before consent_valid_until: expired early, revoked by the user
// (at the bank or on Enable Banking's consent page) or closed. All need a new consent.
const CONSENT_ENDED = new Set(["EXPIRED_SESSION", "REVOKED_SESSION", "CLOSED_SESSION"]);

async function getEb(fetch: Deps["fetch"], token: string, path: string) {
  const res = await fetch(`${EB}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    // code = EB's error name (e.g. EXPIRED_SESSION) when the body is JSON; the body itself is never kept.
    const body = await res.json().catch(() => null);
    const code = /^[A-Z_]+$/.test(body?.error) ? body.error : undefined;
    throw Object.assign(new Error(`API error ${res.status}`), { status: res.status, ...(code && { code }) });
  }
  return res.json();
}

// Pushes into `into` page by page, so the pages read before a failure are not lost.
async function getAllTransactions(
  fetch: Deps["fetch"],
  token: string,
  ebId: string,
  query: Record<string, string>,
  into: EbTransaction[],
) {
  let continuationKey: string | null = null;
  do {
    const params = new URLSearchParams(query);
    if (continuationKey) params.set("continuation_key", continuationKey);
    const data = await getEb(fetch, token, `${ebId}/transactions?${params}`);
    into.push(...(data.transactions || []));
    // longest can answer an empty page with a key: keep going until no key comes back.
    continuationKey = data.continuation_key || null;
  } while (continuationKey);
}

// The user's own IBANs, to mark transactions between their accounts. Undefined when unreadable:
// the rows then leave own_counterparty out, so the upsert keeps what an earlier sync stored.
async function fetchOwnIbans(supabase: Db, userId: string): Promise<Set<string> | undefined> {
  const { data, error } = await supabase.from("accounts").select("iban").eq("user_id", userId).not("iban", "is", null);
  if (error) {
    console.error(`Own accounts not read: ${errorTag(error)}`);
    return undefined;
  }
  return new Set((data ?? []).map((a: { iban: string | null }) => normalizeIban(a.iban)).filter(Boolean));
}

// Rows and the cursor stay under the PK (uid). Never throws for EB failures: rejected carries
// the status when EB refuses the id. cursor = the new last_synced, null when it must not move.
export async function syncAccountTransactions(
  { fetch, supabase }: Deps,
  token: string,
  account: SyncAccount,
  lastSynced: string | null,
  today: string,
) {
  // First sync: the longest history the bank keeps. Many banks give a year or more only in the
  // first hour after the consent, which is when complete-bank-consent starts this sync.
  // Later syncs re-fetch an overlap before the cursor: banks post transactions days after their
  // booking_date, so a cursor of "today" would skip them forever. Upsert dedupes.
  // A first sync that ran out of time last run would restart longest from page 1 every run (the
  // continuation key dies with the run): fall back to the last 90 days instead.
  const dateFrom = lastSynced
    ? new Date(Date.parse(lastSynced) - OVERLAP_DAYS * DAY_MS).toISOString().slice(0, 10)
    : account.sync_error === "TIMEOUT"
    ? new Date(Date.parse(today) - FALLBACK_FIRST_SYNC_DAYS * DAY_MS).toISOString().slice(0, 10)
    : null;
  const transactions: EbTransaction[] = [];
  let failure: unknown = null;
  try {
    const ebId = ebAccountId(account);
    if (!dateFrom) {
      await getAllTransactions(fetch, token, ebId, { strategy: "longest" }, transactions);
    } else {
      try {
        await getAllTransactions(fetch, token, ebId, { date_from: dateFrom }, transactions);
      } catch (err) {
        // The cursor is older than the history the bank keeps (e.g. a consent renewed months
        // later): default refuses the period, longest reads from as far back as it can.
        if ((err as EbError).code !== "WRONG_TRANSACTIONS_PERIOD") throw err;
        transactions.length = 0;
        await getAllTransactions(fetch, token, ebId, { date_from: dateFrom, strategy: "longest" }, transactions);
      }
    }
  } catch (err) {
    console.error(`Failed to sync: ${errorTag(err)}`);
    failure = err;
  }
  // Pages read before a failure are saved too (a long first sync can hit the deadline); the
  // cursor only moves when every page came in.
  if (transactions.length > 0) {
    let rows;
    try {
      const ownIbans = await fetchOwnIbans(supabase, account.user_id);
      rows = await buildRows(transactions, account.uid, account.user_id, ownIbans);
      if (rows.length > 0) {
        const { error } = await supabase.from("transactions").upsert(rows, { onConflict: "account_uid,entry_reference" });
        if (error) throw error;
      }
    } catch (err) {
      console.error(`Supabase insert error: ${errorTag(err)}`);
      return { upserted: 0, rejected: null, cursor: null, error: "SAVE_FAILED" };
    }
    if (failure) return { upserted: rows.length, rejected: rejectedStatus(failure as EbError), cursor: null, error: syncErrorCode(failure) };
    return { upserted: rows.length, rejected: null, cursor: today, error: null };
  }
  if (failure) return { upserted: 0, rejected: rejectedStatus(failure as EbError), cursor: null, error: syncErrorCode(failure) };
  return { upserted: 0, rejected: null, cursor: today, error: null };
}

// Older rows lack identification_hash (and iban) or account_type: ask EB once and store them.
// A bank that sends no type gets "checking" (what unknown counts as), so the call is not
// repeated. Best effort.
async function fillMissingIds({ fetch, supabase }: Deps, token: string, account: SyncAccount) {
  const needType = account.account_type === null;
  if (account.identification_hash && !needType) return;
  try {
    const details = await getEb(fetch, token, `${ebAccountId(account)}/details`);
    const patch: Record<string, unknown> = {};
    if (!account.identification_hash) {
      if (details?.identification_hash) {
        const iban = details.account_id?.iban;
        Object.assign(patch, { identification_hash: details.identification_hash, ...(iban && { iban }) });
      } else {
        console.error("Account ids not filled: no hash in details");
      }
    }
    if (needType) patch.account_type = accountType(details?.cash_account_type) ?? "checking";
    if (Object.keys(patch).length === 0) return;
    const { error } = await supabase.from("accounts").update(patch).eq("uid", account.uid);
    if (error) throw error;
  } catch (err) {
    console.error(`Account ids not filled: ${errorTag(err)}`);
  }
}

// CONSENT_ENDED: the bank closed the consent before consent_valid_until. Ending it today
// shows the Renew banner and the consent push. Never moves a date later. Returns whether marked.
async function markForRenewal(supabase: Db, account: SyncAccount, err: EbError, today: string) {
  if (!err.code || !CONSENT_ENDED.has(err.code)) return false;
  if (account.consent_valid_until && account.consent_valid_until.slice(0, 10) <= today) return false;
  try {
    // Compare-and-set on the date read at start: a Renew during the sync writes a new date
    // that a stale EXPIRED_SESSION must not overwrite.
    const query = supabase.from("accounts").update({ consent_valid_until: today }).eq("uid", account.uid);
    const { error } = await (account.consent_valid_until
      ? query.eq("consent_valid_until", account.consent_valid_until)
      : query.is("consent_valid_until", null));
    if (error) throw error;
    return true;
  } catch (updateErr) {
    console.error(`Account not marked for renewal: ${errorTag(updateErr)}`);
    return false;
  }
}

// The snapshot is saved under the PK (uid). Never throws for EB failures: ebFailed says the bank
// refused or failed the balance call, so the caller can skip spending more calls on it.
export async function syncAccountBalance(deps: Deps, token: string, account: SyncAccount, today: string) {
  await fillMissingIds(deps, token, account);
  try {
    const data = await getEb(deps.fetch, token, `${ebAccountId(account)}/balances`);
    const balance = data.balances?.[0];
    if (!balance) {
      console.log("No balance returned.");
      return { row: null, rejected: null, renewed: false, ebFailed: false, error: null };
    }
    const row = {
      account_uid: account.uid,
      currency: balance.balance_amount.currency,
      amount: parseFloat(balance.balance_amount.amount),
      snapshot_date: today,
      user_id: account.user_id,
    };
    return { row, rejected: null, renewed: false, ebFailed: false, error: null };
  } catch (err) {
    console.error(`Failed to fetch balance: ${errorTag(err)}`);
    const renewed = await markForRenewal(deps.supabase, account, err as EbError, today);
    return { row: null, rejected: rejectedStatus(err as EbError), renewed, ebFailed: true, error: syncErrorCode(err) };
  }
}
