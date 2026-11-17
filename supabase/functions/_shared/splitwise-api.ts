// A read-only client for the Splitwise API (v3.0) with a user's personal API key, sent as a
// Bearer token. Amounts come as decimal strings and are parsed to integer cents exactly, never
// through floats. Errors carry a fixed message and the HTTP status only: never the key, never
// Splitwise's answer (it can quote names or amounts).
export const SPLITWISE_API = "https://secure.splitwise.com/api/v3.0";

export class SplitwiseApiError extends Error {
  override name = "SplitwiseApiError";
  constructor(message: string, readonly status: number | null = null) {
    super(message);
  }
}
/** 401: the key was revoked or regenerated. The user has to connect again. */
export class SplitwiseAuthError extends SplitwiseApiError {
  override name = "SplitwiseAuthError";
}
/** 429: slow down. Splitwise publishes no limits; Retry-After is used when it is sent. */
export class SplitwiseRateLimitError extends SplitwiseApiError {
  override name = "SplitwiseRateLimitError";
  constructor(message: string, status: number, readonly retryAfterSeconds: number | null) {
    super(message, status);
  }
}

const AMOUNT = /^(-)?(\d+)(?:\.(\d+))?$/;

/** "25.0" → 2500. A third decimal rounds half away from zero (Splitwise sends two). */
export function toCents(value: string | number): number {
  const m = typeof value === "string" || typeof value === "number" ? String(value).trim().match(AMOUNT) : null;
  if (!m) throw new SplitwiseApiError("Splitwise sent an unreadable amount");
  const [, minus, whole, frac = ""] = m;
  const milli = Number(whole) * 1000 + Number(frac.padEnd(3, "0").slice(0, 3));
  const cents = Math.floor((milli + 5) / 10);
  return minus && cents !== 0 ? -cents : cents;
}

/** 1234 → "12.34": what the database gets, so numeric stores it exactly. */
export function centsToDecimal(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export type SwUser = { id: number; first_name?: string | null; last_name?: string | null };
export type SwBalance = { currency_code: string; amount: string };
export type SwShare = { user_id: number; paid_share: string; owed_share: string; user?: SwUser | null };
export type SwExpense = {
  id: number;
  group_id?: number | null;
  description?: string | null;
  cost?: string;
  currency_code?: string;
  date?: string;
  updated_at?: string;
  deleted_at?: string | null;
  payment?: boolean;
  /** Splitwise's own category (its name in the user's language). */
  category?: { id?: number; name?: string | null } | null;
  users?: SwShare[];
};
export type SwDebt = { from: number; to: number; amount: string; currency_code: string };
export type SwGroup = {
  id: number;
  name?: string | null;
  members?: Array<SwUser & { balance?: SwBalance[] }>;
  original_debts?: SwDebt[];
};
export type SwFriend = SwUser & { balance?: SwBalance[] };

export type SplitwiseClient = ReturnType<typeof splitwiseClient>;

const UNREADABLE = "Splitwise sent an unreadable answer";

export function splitwiseClient(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  { pageSize = 200, maxPages = 500, timeoutMs = 20_000 }: { pageSize?: number; maxPages?: number; timeoutMs?: number } = {},
) {
  async function get(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const url = new URL(`${SPLITWISE_API}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // A hanging call would hold the whole cron run until the platform kills it.
    const signal = AbortSignal.timeout(timeoutMs);
    const timedOut = (err: unknown) => {
      if (signal.aborted) throw new SplitwiseApiError("Splitwise did not answer in time");
      throw err;
    };
    const res = await fetchFn(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal })
      .catch(timedOut);
    if (res.status === 401) {
      await res.body?.cancel();
      throw new SplitwiseAuthError("Splitwise refused the API key", 401);
    }
    if (res.status === 429) {
      await res.body?.cancel();
      const after = Number(res.headers.get("Retry-After"));
      throw new SplitwiseRateLimitError("Splitwise asked to slow down", 429, Number.isFinite(after) && after > 0 ? after : null);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new SplitwiseApiError(`Splitwise answered HTTP ${res.status}`, res.status);
    }
    const body = await res.json().catch((err) => (signal.aborted ? timedOut(err) : null));
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new SplitwiseApiError(UNREADABLE, res.status);
    const errors = (body as { errors?: unknown }).errors;
    const hasErrors = Array.isArray(errors) ? errors.length > 0 : typeof errors === "object" && errors !== null && Object.keys(errors).length > 0;
    if ((body as { success?: unknown }).success === false || hasErrors) {
      throw new SplitwiseApiError("Splitwise refused the request", res.status);
    }
    return body as Record<string, unknown>;
  }

  function list<T>(body: Record<string, unknown>, key: string): T[] {
    const v = body[key];
    if (!Array.isArray(v)) throw new SplitwiseApiError(UNREADABLE);
    return v as T[];
  }

  return {
    async currentUser(): Promise<SwUser> {
      const user = (await get("get_current_user")).user as SwUser | null;
      if (!user || typeof user.id !== "number") throw new SplitwiseApiError(UNREADABLE);
      return user;
    },
    /** Every expense of mine (all groups and friends), deleted ones included; changed since updatedAfter when given. */
    async expenses({ updatedAfter }: { updatedAfter?: string } = {}): Promise<SwExpense[]> {
      const out: SwExpense[] = [];
      // Only an empty page ends it: Splitwise documents no maximum limit, and may send fewer.
      for (let page = 0; page < maxPages; page++) {
        const params: Record<string, string> = { limit: String(pageSize), offset: String(out.length) };
        if (updatedAfter) params.updated_after = updatedAfter;
        const rows = list<SwExpense>(await get("get_expenses", params), "expenses");
        if (rows.length === 0) return out;
        out.push(...rows);
      }
      throw new SplitwiseApiError("Splitwise has too many expenses to read in one run");
    },
    async groups(): Promise<SwGroup[]> {
      return list<SwGroup>(await get("get_groups"), "groups");
    },
    async friends(): Promise<SwFriend[]> {
      return list<SwFriend>(await get("get_friends"), "friends");
    },
  };
}
