// The bank (ASPSP) behind a linked account. Enable Banking's /sessions response
// names the bank and its country but not its logo; /aspsps?country= lists logos.

export interface BankInfo { bank_name: string | null; bank_country: string | null; bank_logo: string | null }

export function bankLogo(aspsps: Array<{ name: string; logo?: string | null }> | null, name: string): string | null {
  return aspsps?.find((a) => a.name === name)?.logo ?? null;
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
