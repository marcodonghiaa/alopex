// The sync-bank request handler, apart from Deno.serve so it can be tested (see index.ts).
import type { Db } from "../_shared/batch-update.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { hasSecretKey } from "../_shared/secret-key.ts";
import {
  ACCOUNT_COLUMNS,
  recordSyncError,
  signOrRecord,
  type SyncAccount,
  syncAccountBalance,
  syncAccountTransactions,
  syncStatus,
} from "../_shared/bank-sync.ts";

// All bank calls of one invocation share this budget, leaving time under the 150 s
// wall clock to save the cursor and snapshot. An aborted run keeps the old cursor.
const BANK_DEADLINE_MS = 120000;

const fail = (status: number, error: string) => Response.json({ error }, { status });

export type SyncBankDeps = {
  supabase: Db;
  secretKeys: Record<string, string>;
  sign: () => Promise<string>;
  fetch?: typeof fetch;
};

export const syncBankHandler = ({ supabase, secretKeys, sign, fetch: fetchFn = fetch }: SyncBankDeps) => async (req: Request) => {
  const started = Date.now();
  if (!hasSecretKey(req, secretKeys)) return fail(401, "secret key required");
  const body = await req.json().catch(() => null);
  const accountUid = body?.account_uid;
  if (typeof accountUid !== "string" || !accountUid) return fail(400, "account_uid required");

  const { data: account, error }: { data: SyncAccount | null; error: unknown } = await supabase
    .from("accounts").select(ACCOUNT_COLUMNS).eq("uid", accountUid).maybeSingle();
  if (error) {
    console.error(`Failed to load account: ${errorTag(error)}`);
    return fail(500, "account lookup failed");
  }
  if (!account) return fail(404, "account not found");

  const cursorRead = await supabase
    .from("sync_cursors").select("last_synced").eq("account_uid", account.uid).maybeSingle();
  if (cursorRead.error) {
    // Without the cursor the sync would treat this as a first sync and re-read the longest
    // history the bank keeps: spend no bank call on a guess.
    console.error(`Failed to read sync cursor: ${errorTag(cursorRead.error)}`);
    return fail(500, "cursor lookup failed");
  }

  const deadline = AbortSignal.timeout(BANK_DEADLINE_MS);
  const deps = {
    fetch: ((url: string | URL | Request, init: RequestInit = {}) => fetchFn(url, { ...init, signal: deadline })) as typeof fetch,
    supabase,
  };
  const token = await signOrRecord(supabase, account, sign, new Date().toISOString());
  if (!token) return fail(500, "Enable Banking key invalid");
  const today = new Date().toISOString().slice(0, 10);

  // Balance first: it is the call that marks a consent the bank closed early (EXPIRED_SESSION).
  const balance = await syncAccountBalance(deps, token, account, today);
  let balanceSaved = false;
  if (balance.row) {
    // one snapshot per account per day: upsert avoids duplicates if run twice the same day
    const { error } = await supabase
      .from("net_worth_snapshots").upsert(balance.row, { onConflict: "account_uid,snapshot_date" });
    if (error) console.error(`Snapshot not saved: ${errorTag(error)}`);
    balanceSaved = !error;
  }

  // The bank just refused or failed this account: don't spend more of its daily calls on it.
  const tx = balance.ebFailed
    ? { upserted: 0, cursor: null, error: null }
    : await syncAccountTransactions(deps, token, account, cursorRead.data?.last_synced ?? null, today);
  if (tx.cursor) {
    const { error } = await supabase
      .from("sync_cursors").upsert({ account_uid: account.uid, last_synced: tx.cursor }, { onConflict: "account_uid" });
    if (error) console.error(`Sync cursor not saved: ${errorTag(error)}`);
  }

  // The first failure of this run, shown on the account until a run succeeds.
  const syncError = await recordSyncError(supabase, account, balance.error, tx.error, new Date().toISOString());

  const result = {
    upserted: tx.upserted,
    balance_saved: balanceSaved,
    renewed: balance.renewed,
    error: syncError,
    ms: Date.now() - started,
  };
  console.log(`sync-bank: ${JSON.stringify(result)}`);
  // Not 200 when the transactions did not sync, so pg_net's net._http_response shows the failure.
  return Response.json(result, { status: syncStatus(tx.cursor, syncError) });
};
