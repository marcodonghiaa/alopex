// Enable Banking sessions: closing them, so a bank stops sharing data with this app. Used when
// a link is refused (burnCode) and when a user deletes their account (closeSessions).
import { signEnableBankingJwt } from "./enable-banking.ts";
import { errorTag } from "./log-safe.ts";

// A code whose link was refused (another user's state, or expired) must not stay redeemable:
// whoever obtained it could pair it with a state of their own. Exchange it and close the session
// straight away. Best effort: Enable Banking codes are short-lived anyway.
export async function burnCode(
  code: string,
  fetchFn: typeof fetch = fetch,
  sign: () => Promise<string> = signEnableBankingJwt,
): Promise<void> {
  try {
    const token = await sign();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const res = await fetchFn("https://api.enablebanking.com/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && typeof data.session_id === "string") {
      await fetchFn(`https://api.enablebanking.com/sessions/${encodeURIComponent(data.session_id)}`, {
        method: "DELETE",
        headers,
      });
    }
  } catch (err) {
    console.error(`refused code not closed: ${errorTag(err)}`);
  }
}

// Closes Enable Banking sessions so the bank stops sharing data with this app. Best effort per
// session: one that is already closed or expired is not an error worth stopping for.
export async function closeSessions(
  sessionIds: string[],
  fetchFn: typeof fetch = fetch,
  sign: () => Promise<string> = signEnableBankingJwt,
): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const token = await sign();
  let closed = 0;
  for (const id of sessionIds) {
    try {
      const res = await fetchFn(`https://api.enablebanking.com/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok || res.status === 404) closed++;
      else console.error(`bank session not closed: ${errorTag({ status: res.status })}`);
    } catch (err) {
      console.error(`bank session not closed: ${errorTag(err)}`);
    }
  }
  return closed;
}

// Sessions a renewal replaced: the old session of each relinked account, when no account of the
// user still reads from it. Closing them leaves one live consent per bank instead of two until
// the old one expires. Accounts linked before bank_session_id existed (null) are never closed.
export function replacedSessions(
  before: Array<{ uid: string; bank_session_id?: string | null }>,
  relinked: Set<string>,
  newSession: string,
): string[] {
  const stillUsed = new Set(before.filter((a) => !relinked.has(a.uid)).map((a) => a.bank_session_id));
  stillUsed.add(newSession);
  const old = before.filter((a) => relinked.has(a.uid)).map((a) => a.bank_session_id);
  return [...new Set(old)].filter((id): id is string => !!id && !stillUsed.has(id));
}

/** Account patch for a renewed consent: records the new session and clears the last sync error. */
export function relinkPatch(sessionId: string | null) {
  return sessionId ? { bank_session_id: sessionId, sync_error: null, sync_error_at: null } : {};
}

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };

// After a renewal: closes the sessions it replaced. Accounts are re-read just before closing,
// because a second renewal running at the same time may have pointed accounts at one of them.
// Best effort: a failure only leaves the old session to expire on its own; its bank_sessions
// row stays unless every close succeeded, so deleting the user account can still close it.
export async function closeReplaced(
  supabase: Db,
  userId: string,
  before: Array<{ uid: string; bank_session_id?: string | null }>,
  relinked: Set<string>,
  newSession: string,
  fetchFn: typeof fetch = fetch,
  sign: () => Promise<string> = signEnableBankingJwt,
): Promise<void> {
  const candidates = replacedSessions(before, relinked, newSession);
  if (candidates.length === 0) return;
  try {
    const { data, error: readError } = await supabase
      .from("accounts")
      .select("bank_session_id")
      .eq("user_id", userId)
      .in("bank_session_id", candidates);
    if (readError) throw readError;
    const inUse = new Set((data ?? []).map((r: { bank_session_id: string }) => r.bank_session_id));
    const replaced = candidates.filter((id) => !inUse.has(id));
    if (replaced.length === 0) return;
    if (await closeSessions(replaced, fetchFn, sign) === replaced.length) {
      const { error } = await supabase.from("bank_sessions").delete().in("session_id", replaced);
      if (error) throw error;
    }
  } catch (err) {
    console.error(`replaced bank session not closed: ${errorTag(err)}`);
  }
}
