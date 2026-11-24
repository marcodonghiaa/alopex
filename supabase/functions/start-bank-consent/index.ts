// Supabase Edge Function: start-bank-consent
//
// First step of self-serve bank linking. Given a bank name + country, signs
// the Enable Banking RS256 JWT server-side (logic that used to live in a
// local CLI script) and returns the consent
// URL the user's browser should be redirected to.
//
// Called via supabase.functions.invoke from the browser, so it needs real
// CORS handling -- the browser preflights with OPTIONS before the actual
// POST, and without an explicit 200 + Allow-* response there the request
// never leaves the browser at all ("Failed to send a request").

import { EB_KEY_INVALID, signEnableBankingJwt } from "../_shared/enable-banking.ts";
import { serveWithCors } from "../_shared/origins.ts";
import { asUser } from "../_shared/clients.ts";
import { isBankName, isCountryCode, MAX_OPEN_CONSENTS } from "../_shared/validate.ts";
import { CONSENT_WINDOW_MS } from "../_shared/consent-claim.ts";
import { mfaRefusal } from "../_shared/mfa.ts";
import { consentEnd, requestConsentUrl } from "../_shared/bank-info.ts";

Deno.serve(serveWithCors(async (req, json, origin) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabase = asUser(req.headers.get("Authorization")!);
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return json({ error: "Not signed in" }, 401);
  }
  const mfa = await mfaRefusal(supabase);
  if (mfa) return json(mfa.body, mfa.status);

  let body: { bankName?: string; country?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || !isBankName(body.bankName) || !isCountryCode(body.country)) {
    return json({ error: "A valid bankName and country are required" }, 400);
  }

  // Sign first: a bad key must not leave a pending row that counts toward MAX_OPEN_CONSENTS.
  const token = await signEnableBankingJwt().catch(() => null);
  if (!token) return json({ error: EB_KEY_INVALID }, 500);

  // Enable Banking treats `state` as an opaque pass-through it never
  // validates -- a bare user id there would let anyone who completes their
  // own consent hand-edit state to a victim's id before hitting the
  // callback. Issue a single-use, unguessable token instead; complete-bank-consent
  // deletes the row through the signed-in user's session, so only its owner can use it.
  // Tokens older than the 15 minute window can never be used; clear the caller's.
  await supabase
    .from("pending_bank_consents")
    .delete()
    .lt("created_at", new Date(Date.now() - CONSENT_WINDOW_MS).toISOString());
  // Every request costs an Enable Banking call; cap how many one user can have open at once.
  const { count: openConsents, error: countError } = await supabase
    .from("pending_bank_consents")
    .select("id", { count: "exact", head: true });
  if (countError) {
    return json({ error: "Couldn't start consent" }, 500);
  }
  if ((openConsents ?? 0) >= MAX_OPEN_CONSENTS) {
    return json({ error: "Too many bank connections in progress, try again in 15 minutes" }, 429);
  }
  const { data: pending, error: pendingError } = await supabase
    .from("pending_bank_consents")
    // The dashboard that started the link: the callback sends the browser back to this origin.
    .insert({ user_id: userData.user.id, origin })
    .select("id")
    .single();
  if (pendingError || !pending) {
    return json({ error: "Couldn't start consent" }, 500);
  }

  // Banks cap the consent (maximum_consent_validity); asking past it can fail the link.
  const validUntil = await consentEnd(token, body.country, body.bankName, Date.now());

  const result = await requestConsentUrl({
    token,
    bankName: body.bankName,
    country: body.country,
    validUntil,
    state: pending.id,
    redirectUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/bank-consent-callback`,
    discard: () => supabase.from("pending_bank_consents").delete().eq("id", pending.id),
  });
  return "url" in result ? json({ url: result.url }) : json({ error: result.error }, result.status);
}));
