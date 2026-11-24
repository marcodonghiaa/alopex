// Supabase Edge Function: complete-bank-consent
//
// Last step of self-serve bank linking, called by the signed-in dashboard with the { code, state }
// that bank-consent-callback handed it. The pending row is deleted through the caller's own
// session, so RLS only finds it when the caller is the user who started this link: someone who
// completes another user's consent URL gets "Invalid or expired" and links nothing.

import { createClient } from "jsr:@supabase/supabase-js@2.119.0";
import { serveWithCors } from "../_shared/origins.ts";
import { asUser as userClient, SECRET_KEY } from "../_shared/clients.ts";
import { linkAccounts } from "../_shared/link-accounts.ts";
import { burnCode } from "../_shared/eb-sessions.ts";
import { claimConsent, isConsentInput } from "../_shared/consent-claim.ts";
import { startFirstSync } from "../_shared/first-sync.ts";
import { mfaRefusal } from "../_shared/mfa.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const service = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(serveWithCors(async (req, json) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const asUser = userClient(req.headers.get("Authorization")!);
  const { data: userData, error: userError } = await asUser.auth.getUser();
  if (userError || !userData.user) return json({ error: "Not signed in" }, 401);
  const mfa = await mfaRefusal(asUser);
  if (mfa) return json(mfa.body, mfa.status);

  const body = await req.json().catch(() => null);
  if (!isConsentInput(body)) return json({ error: "Missing code or state" }, 400);

  const claim = await claimConsent(asUser, body.state, userData.user.id, Date.now());
  if ("error" in claim) {
    if (claim.transient) return json({ error: claim.error }, 503);
    // The state is someone else's (the link was started by another user): close the code, so it
    // can't be paired with a state of their own. A state that doesn't exist costs no bank call.
    const { data: foreign } = await service
      .from("pending_bank_consents").select("id").eq("id", body.state).maybeSingle();
    if (foreign) await burnCode(body.code);
    return json({ error: claim.error }, 403);
  }

  const result = await linkAccounts(service, userData.user.id, body.code);
  if ("error" in result) return json({ error: result.error }, 502);

  // Transactions now, not at the next cron run; the reply does not wait for it.
  EdgeRuntime.waitUntil(startFirstSync(
    Deno.env.get("SUPABASE_URL")!,
    SECRET_KEY,
    result.syncUids,
    fetch,
    // Then categories, transfers and subscriptions right away, not at the next 6-hour run.
    async () => {
      const { error } = await service.rpc("queue_edge_job", { job: "post-sync", round: 1 });
      if (error) throw error;
    },
  ));
  return json(result.params);
}));
