// Supabase Edge Function: reapply-rules
//
// The Rules page's "Apply to past transactions". Body: { "apply": false } previews how many
// transactions your current rules would re-categorize (plus a few examples); { "apply": true }
// does it. The caller's JWT only identifies them; reads and writes use the service key, each
// scoped to that user, because a write with the user's JWT would mark every changed row as
// hand-set (trg_mark_manual_category). Categories you set by hand are never changed (see
// _shared/reapply-rules.ts).

import { serveWithCors } from "../_shared/origins.ts";
import { reapplyHandler } from "./handler.ts";
import { serviceClient, userCaller } from "../_shared/clients.ts";

Deno.serve(serveWithCors(reapplyHandler({
  ...userCaller,
  admin: () => serviceClient(),
})));
