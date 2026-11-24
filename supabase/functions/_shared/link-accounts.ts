// The second half of bank linking, shared by complete-bank-consent: exchanges Enable Banking's
// one-time code for a session, then stores the accounts it shares under `userId`. The caller must
// already have proved that `userId` is the signed-in user who started this link.

import { EB_NO_ACCOUNTS, signEnableBankingJwt } from "./enable-banking.ts";
import { errorTag } from "./log-safe.ts";
import { accountType, matchAccount, matchPatch, type StoredAccount } from "./account-match.ts";
import { bankLogo, type BankInfo, fetchAspsps } from "./bank-info.ts";
import { linkedParams } from "./linked-summary.ts";
import { latestFxRows } from "./fx-rates.ts";
import { closeReplaced, relinkPatch } from "./eb-sessions.ts";

export const LINK_FAILED = "Couldn't link the bank, please try again";

interface EnableBankingAccount {
  uid: string;
  currency: string;
  name?: string | null;
  account_id?: { iban?: string | null } | null;
  identification_hash?: string | null;
  cash_account_type?: string | null;
}

export type LinkResult = { params: Record<string, string>; syncUids: string[] } | { error: string };

// deno-lint-ignore no-explicit-any
export async function linkAccounts(supabase: any, userId: string, code: string): Promise<LinkResult> {
  // Log the real reason server-side; the reply only gets a generic message.
  const fail = (err: unknown): { error: string } => {
    console.error(`bank link failed: ${errorTag(err)}`);
    return { error: LINK_FAILED };
  };
  // One account's failed write skips only that account (H160): the ones saved still get their
  // first sync while the bank allows a long history read. The link fails only if none was saved.
  const skip = (err: unknown) => console.error(`bank account not linked: ${errorTag(err)}`);

  try {
    const token = await signEnableBankingJwt();
    const res = await fetch("https://api.enablebanking.com/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return fail({ status: res.status });
    }

    const accounts = (data.accounts ?? []) as Array<EnableBankingAccount>;
    if (accounts.length === 0) return { error: EB_NO_ACCOUNTS };
    const consentValidUntil = data.access?.valid_until ?? null;

    // The bank itself (name, country), not the holder name EB returns as the account name.
    // Logo comes from /aspsps; best-effort, a failed lookup only leaves the logo null.
    const aspsp = (data.aspsp ?? null) as { name?: string | null; country?: string | null } | null;
    const bankName = aspsp?.name ?? null;
    const bankCountry = aspsp?.country ?? null;
    let logo: string | null = null;
    if (bankName && bankCountry) {
      logo = bankLogo(await fetchAspsps(token, bankCountry), bankName);
    }
    const bank: BankInfo = { bank_name: bankName, bank_country: bankCountry, bank_logo: logo };

    // Kept so the session can be closed at Enable Banking when the user deletes their account.
    // Best effort: a failed write only means that session is left to expire on its own.
    const sessionId: string | null = typeof data.session_id === "string" ? data.session_id : null;
    if (sessionId) {
      const { error: sessionError } = await supabase
        .from("bank_sessions")
        .upsert({ session_id: sessionId, user_id: userId, bank_name: bankName }, { onConflict: "session_id" });
      if (sessionError) console.error(`bank session not stored: ${errorTag(sessionError)}`);
    }
    const savedRows: Array<{ uid: string; label: string | null; currency: string }> = [];

    // uid is the PK (transactions, snapshots and sync_cursors reference it), so an existing row's uid
    // never changes. eb_account_uid follows the session: EB account ids die with their session, so a
    // renewal stores the new one there.
    // Match on identification_hash (IBAN + currency, unique per Revolut pocket), then IBAN + currency.
    const { data: storedRows, error: storedError } = await supabase
      .from("accounts")
      .select("uid, iban, currency, identification_hash, account_type, bank_session_id")
      .eq("user_id", userId);
    if (storedError) return fail(storedError);
    const sessionsBefore: Array<{ uid: string; bank_session_id?: string | null }> = storedRows ?? [];
    const relinked = new Set<string>(); // existing accounts this consent renewed
    // Which session each account reads from, so a renewal can close the one it replaced.
    const sessionPatch = relinkPatch(sessionId);
    let stored: StoredAccount[] = storedRows ?? [];
    const raced = new Set<string>(); // inserted by a concurrent callback, which syncs it itself

    for (const a of accounts) {
      const iban = a.account_id?.iban ?? null;
      const identificationHash = a.identification_hash ?? null;
      const label = a.name ?? null;
      const type = accountType(a.cash_account_type);

      let uid = matchAccount(stored, { iban, currency: a.currency, identification_hash: identificationHash });

      if (!uid) {
        const { error } = await supabase.from("accounts").insert({
          uid: a.uid,
          eb_account_uid: a.uid,
          currency: a.currency,
          label,
          iban,
          identification_hash: identificationHash,
          account_type: type,
          user_id: userId,
          consent_valid_until: consentValidUntil,
          ...bank,
          ...sessionPatch,
        });
        if (!error) {
          stored = [...stored, { uid: a.uid, iban, currency: a.currency, identification_hash: identificationHash, account_type: type }];
          savedRows.push({ uid: a.uid, label, currency: a.currency });
          continue;
        }
        // A concurrent callback inserted the same pocket first (unique user_id + identification_hash).
        if (error.code !== "23505" || !identificationHash) {
          skip(error);
          continue;
        }
        // Named racedRow: `raced` (the Set) must stay in scope for raced.add below.
        const { data: racedRow, error: racedError } = await supabase
          .from("accounts")
          .select("uid, iban, currency, identification_hash, account_type")
          .eq("user_id", userId)
          .eq("identification_hash", identificationHash)
          .maybeSingle() as { data: StoredAccount | null; error: unknown };
        if (racedError || !racedRow) {
          skip(racedError ?? { name: "RacedRowMissing" });
          continue;
        }
        stored = [...stored, racedRow];
        uid = racedRow.uid;
        raced.add(uid);
      }

      // The type only fills a gap: a type the user corrected stays.
      const storedType = stored.find((s) => s.uid === uid)?.account_type ?? null;
      const patch = {
        ...matchPatch({ iban, currency: a.currency, identification_hash: identificationHash, label }, a.uid, consentValidUntil, bank),
        ...(storedType === null && type !== null && { account_type: type }),
        ...sessionPatch,
      };
      const { error } = await supabase
        .from("accounts")
        .update(patch)
        .eq("uid", uid);
      if (error) {
        skip(error);
        continue;
      }
      stored = stored.map((s) =>
        s.uid === uid
          ? { ...s, iban: iban ?? s.iban, currency: a.currency, identification_hash: identificationHash ?? s.identification_hash }
          : s
      );
      savedRows.push({ uid, label, currency: a.currency });
      relinked.add(uid);
    }

    if (savedRows.length === 0) return fail({ name: "NoAccountSaved" });

    // A renewal leaves the old session open at Enable Banking until it expires: close it once
    // no account reads from it.
    if (sessionId) await closeReplaced(supabase, userId, sessionsBefore, relinked, sessionId);

    // A fresh instance has no fx_rates until the first sync, and v_net_worth_eur counts a currency
    // with no rate as 0. Seed the latest rates now. Best-effort, sync-prices keeps them current.
    try {
      const rows = await latestFxRows(savedRows.map((r) => r.currency));
      if (rows.length > 0) {
        const { error } = await supabase.from("fx_rates").upsert(rows, { onConflict: "date,currency" });
        if (error) throw error;
      }
    } catch (err) {
      console.error(`fx seed failed: ${errorTag(err)}`);
    }

    return {
      params: linkedParams(savedRows.length, bank.bank_name, savedRows.map((r) => r.currency)),
      // H038: renewed accounts too, while the bank still allows a long read right after consent.
      // sync-bank reads each balance first, so no separate balance call is spent here.
      // Once each: two shared accounts can match one stored account, and one sync is enough.
      syncUids: [...new Set(savedRows.map((r) => r.uid))].filter((uid) => !raced.has(uid)),
    };
  } catch (err) {
    return fail(err);
  }
}
