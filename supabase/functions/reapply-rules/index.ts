// Supabase Edge Function: reapply-rules
//
// The Rules page's "Apply to past transactions". Body: { "apply": false } previews how many
// transactions your current rules would re-categorize (plus a few examples); { "apply": true }
// does it. The caller's JWT only identifies them; reads and writes use the service key, each
// scoped to that user, because a write with the user's JWT would mark every changed row as
// hand-set (trg_mark_manual_category). Categories you set by hand are never changed (see
// _shared/reapply-rules.ts).

import { createClient } from "jsr:@supabase/supabase-js@2.119.0";
import { serveWithCors } from "../_shared/origins.ts";
import { reapplyHandler } from "./handler.ts";
import { userCaller } from "../_shared/clients.ts";

const url = Deno.env.get("SUPABASE_URL")!;

Deno.serve(serveWithCors(reapplyHandler({
  ...userCaller,
  admin: () => createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
})));
