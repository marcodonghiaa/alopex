// Supabase Edge Function: refresh-recurring
//
// The Subscriptions page calls this when it opens, so your edits to transactions (a new name,
// One-time instead of Subscription, a new category, a delete) show there right away instead of
// after the next scheduled detect-recurring run (every 6 h). It runs the same detection for the
// caller only. The caller's JWT only identifies them; reads and the save use the service key,
// scoped to that user, because upsert_detected_streams is service-role only.

import { createClient } from "jsr:@supabase/supabase-js@2.119.0";
import { serveWithCors } from "../_shared/origins.ts";
import { userCaller } from "../_shared/clients.ts";
import { refreshHandler } from "./handler.ts";
import { romeToday } from "../_shared/today.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(serveWithCors(refreshHandler({
  ...userCaller,
  admin: () => admin,
  rpc: (fn, args) => admin.rpc(fn, args),
  today: () => romeToday(),
  now: () => Date.now(),
})));
