// Pick which stored bank account an Enable Banking account maps to.
// identification_hash covers IBAN + currency, so it is unique per Revolut
// currency pocket. IBAN alone is shared by every pocket, so it is only
// trusted together with currency.

import type { BankInfo } from "./bank-info.ts";

export interface StoredAccount {
  uid: string;
  iban: string | null;
  currency: string;
  identification_hash: string | null;
  account_type?: string | null;
}
type IncomingAccount = Omit<StoredAccount, "uid" | "account_type">;

// Enable Banking cash_account_type (ISO 20022) -> accounts.account_type. null = not sent.
const CASH_ACCOUNT_TYPES: Record<string, string> = { CACC: "checking", SVGS: "savings", CARD: "credit_card", LOAN: "loan" };
export function accountType(cashAccountType: unknown): string | null {
  if (typeof cashAccountType !== "string" || cashAccountType === "") return null;
  return CASH_ACCOUNT_TYPES[cashAccountType.toUpperCase()] ?? "other";
}

// Banks list several balances (booked, available, expected...) in their own order. The booked one is
// the account's balance; an available one can include an overdraft or a card's unused credit line.
const BALANCE_TYPES = ["CLBD", "ITBD", "XPCD", "OPBD", "ITAV", "CLAV"];

export type EbBalance = { balance_type?: string; balance_amount: { amount: string; currency: string } };

export function pickBalance(balances: EbBalance[] | undefined): EbBalance | undefined {
  for (const type of BALANCE_TYPES) {
    const found = balances?.find((b) => b.balance_type === type);
    if (found) return found;
  }
  return balances?.[0];
}

export function matchAccount(existing: StoredAccount[], incoming: IncomingAccount): string | null {
  const { iban, currency, identification_hash: hash } = incoming;
  const byHash = hash ? existing.find((s) => s.identification_hash === hash) : undefined;
  if (byHash) return byHash.uid;
  const byIban = iban ? existing.find((s) => s.iban === iban && s.currency === currency) : undefined;
  return byIban?.uid ?? null;
}

// Update for a matched row. eb_account_uid follows the current session (EB ids
// die with their session); iban, hash, label and bank fields only overwrite when the bank sends them.
export function matchPatch(
  incoming: IncomingAccount & { label: string | null },
  ebUid: string,
  consentValidUntil: string | null,
  bank: BankInfo,
): Record<string, unknown> {
  const { iban, currency, identification_hash, label } = incoming;
  const { bank_name, bank_country, bank_logo } = bank;
  return {
    eb_account_uid: ebUid,
    consent_valid_until: consentValidUntil,
    currency,
    ...(iban !== null && { iban }),
    ...(identification_hash !== null && { identification_hash }),
    ...(label !== null && { label }),
    ...(bank_name !== null && { bank_name }),
    ...(bank_country !== null && { bank_country }),
    ...(bank_logo !== null && { bank_logo }),
  };
}
