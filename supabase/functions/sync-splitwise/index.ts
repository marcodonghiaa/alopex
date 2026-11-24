// Supabase Edge Function: sync-splitwise
//
// Brings each connected user's Splitwise expenses in through the Splitwise API, with their own
// API key (kept in Vault; see splitwise-connect). pg_cron calls it every 6 hours with a project
// secret key on the apikey header (verify_jwt = false, like post-sync): every connection, one at
// a time. The signed-in dashboard calls it for "Sync now" (its own connection only), or with
// { "preview": true } for a dry run that returns { new, adopted, review, deleted } and writes
// nothing. The work is in _shared/splitwise-sync-job.ts.

import { hasSecretKey } from "../_shared/secret-key.ts";
import { SECRET_KEYS, serviceClient, userCaller } from "../_shared/clients.ts";
import { serveWithCors } from "../_shared/origins.ts";
import { splitwiseClient } from "../_shared/splitwise-api.ts";
import { syncNowHandler } from "../_shared/splitwise-sync-job.ts";

const service = serviceClient();

// Stop starting new users after this, well under the 150 s wall clock. The rest wait for the next run.
const BUDGET_MS = 100000;

Deno.serve(serveWithCors((req, json) => {
  const started = Date.now();
  return syncNowHandler({
    db: service,
    rpc: (fn, args) => service.rpc(fn, args),
    client: (key) => splitwiseClient(key),
    now: () => Date.now(),
    isServer: (r) => hasSecretKey(r, SECRET_KEYS),
    ...userCaller,
    timeLeft: () => Date.now() - started < BUDGET_MS,
  })(req, json);
}));
