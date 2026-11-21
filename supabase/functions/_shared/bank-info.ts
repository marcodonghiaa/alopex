// The bank (ASPSP) behind a linked account. Enable Banking's /sessions response
// names the bank and its country but not its logo; /aspsps?country= lists logos.

export interface BankInfo { bank_name: string | null; bank_country: string | null; bank_logo: string | null }

export function bankLogo(aspsps: Array<{ name: string; logo?: string | null }> | null, name: string): string | null {
  return aspsps?.find((a) => a.name === name)?.logo ?? null;
}

// The bank picker's choices, A to Z. Banks Enable Banking marks beta are kept and flagged:
// you can link them in its control panel (e2e test: Trade Republic), so hiding them left a
// linked bank missing from Alopex.
export function bankChoices(aspsps: Array<{ name: string; logo?: string | null; beta?: boolean }>) {
  return aspsps
    .map((a) => ({ name: a.name, logo: a.logo ?? null, beta: a.beta === true }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const CONSENT_DAYS = 180;
const DAY_MS = 24 * 3600 * 1000;

// The consent end asked for in POST /auth: 180 days, or the bank's own shorter maximum
// (/aspsps maximum_consent_validity, seconds) a minute early so clock skew can't exceed it.
// Under an hour is not a real maximum: those and missing values keep 180 days.
export function consentValidUntil(aspsps: Array<{ name: string; maximum_consent_validity?: unknown }> | null, name: string, now: number): string {
  const max = aspsps?.find((a) => a.name === name)?.maximum_consent_validity;
  const fallback = now + CONSENT_DAYS * DAY_MS;
  if (typeof max !== "number" || !Number.isFinite(max) || max < 3600) return new Date(fallback).toISOString();
  return new Date(Math.min(fallback, now + max * 1000 - 60_000)).toISOString();
}

export type Aspsp = { name: string; logo?: string | null; maximum_consent_validity?: unknown };

// Enable Banking's bank list for one country (logo, maximum consent length). Best effort with a
// short timeout: null when the call fails, so callers fall back to defaults.
export async function fetchAspsps(token: string, country: string, fetchFn: typeof fetch = fetch): Promise<Aspsp[] | null> {
  try {
    const res = await fetchFn(`https://api.enablebanking.com/aspsps?country=${encodeURIComponent(country)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const list = (await res.json()).aspsps;
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

// start-bank-consent's valid_until: the bank's own maximum, looked up in its country. Best effort:
// a failed lookup asks for the usual 180 days.
export async function consentEnd(
  token: string,
  country: string,
  bankName: string,
  now: number,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  return consentValidUntil(await fetchAspsps(token, country, fetchFn), bankName, now);
}
