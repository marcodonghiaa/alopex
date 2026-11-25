// Supabase Edge Function: complete-bank-consent
//
// Last step of self-serve bank linking, called by the signed-in dashboard with the { code, state }
// that bank-consent-callback handed it. The pending row is deleted through the caller's own
// session, so RLS only finds it when the caller is the user who started this link: someone who
// completes another user's consent URL gets "Invalid or expired" and links nothing.

import { serveWithCors } from "../_shared/origins.ts";
import { asUser, SECRET_KEY, serviceClient, userCaller } from "../_shared/clients.ts";
import { linkAccounts } from "../_shared/link-accounts.ts";
import { burnCode } from "../_shared/eb-sessions.ts";
import { startFirstSync } from "../_shared/first-sync.ts";
import { completeHandler } from "./handler.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const service = serviceClient();

Deno.serve(serveWithCors(completeHandler({
  ...userCaller,
  asUser,
  service,
  linkAccounts: (userId, code) => linkAccounts(service, userId, code),
  burnCode,
  afterLink: (syncUids) =>
    EdgeRuntime.waitUntil(startFirstSync(
      Deno.env.get("SUPABASE_URL")!,
      SECRET_KEY,
      syncUids,
      fetch,
      // Then categories, transfers and subscriptions right away, not at the next scheduled run.
      async () => {
        const { error } = await service.rpc("queue_edge_job", { job: "post-sync", round: 1 });
        if (error) throw error;
      },
    )),
})));
