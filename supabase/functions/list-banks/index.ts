// Supabase Edge Function: list-banks
//
// Powers the bank picker on the Accounts page -- given a country, returns
// Enable Banking's real list of supported banks (ASPSPs) so the user picks
// from a dropdown instead of typing a bank name that has to match exactly.
// Same JWT-signing as start-bank-consent/bank-consent-callback; no writes,
// read-only lookup.
//
// Requires a signed-in user -- otherwise this is an unauthenticated proxy to
// the operator's Enable Banking credentials/quota. verify_jwt is also set in
// supabase/config.toml as a gateway-level backstop; this in-function check is
// the one that's actually reproducible from a plain `supabase functions deploy`.

import { EB_KEY_INVALID, ebErrorMessage, signEnableBankingJwt } from "../_shared/enable-banking.ts";
import { serveWithCors } from "../_shared/origins.ts";
import { userCaller } from "../_shared/clients.ts";
import { callerOrReply } from "../_shared/caller.ts";
import { isCountryCode } from "../_shared/validate.ts";
import { bankChoices } from "../_shared/bank-info.ts";

interface Aspsp {
  name: string;
  country: string;
  logo?: string | null;
  beta?: boolean;
}

Deno.serve(serveWithCors(async (req, json) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const userId = await callerOrReply(req, userCaller, json, "list-banks");
  if (userId instanceof Response) return userId;

  let body: { country?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || !isCountryCode(body.country)) {
    return json({ error: "A valid country is required" }, 400);
  }

  const token = await signEnableBankingJwt().catch(() => null);
  if (!token) return json({ error: EB_KEY_INVALID }, 500);

  try {
    const res = await fetch(
      `https://api.enablebanking.com/aspsps?country=${encodeURIComponent(body.country)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      console.error("Enable Banking error:", res.status);
      return json({ error: ebErrorMessage(res.status) }, 502);
    }
    const data = await res.json();

    const banks = bankChoices((data.aspsps ?? []) as Array<Aspsp>);

    return json({ banks });
  } catch {
    return json({ error: "Something went wrong, please try again" }, 500);
  }
}));
