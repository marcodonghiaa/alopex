// Supabase Edge Function: splitwise-connect
//
// The dashboard's Splitwise connection. POST { apiKey, consent: true } checks the personal API key
// with Splitwise and stores it in Supabase Vault (never in a table column), returning
// { displayName }. POST { disconnect: true, deleteData } deletes the key and the connection, and
// with deleteData what the sync brought in. Signed-in users only, after two-step sign-in
// (verify_jwt = true). The work is in _shared/splitwise-connect.ts.

import { createClient } from "jsr:@supabase/supabase-js@2.119.0";
import { serveWithCors } from "../_shared/origins.ts";
import { mfaRefusal } from "../_shared/mfa.ts";
import { splitwiseClient } from "../_shared/splitwise-api.ts";
import { connectHandler } from "../_shared/splitwise-connect.ts";
import { userIdFrom } from "../reapply-rules/handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const asUser = (authorization: string) =>
  createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authorization } } });

Deno.serve(serveWithCors(connectHandler({
  async userIdFor(authorization) {
    return userIdFrom(await asUser(authorization).auth.getUser());
  },
  async mfaRefusal(authorization) {
    return await mfaRefusal(asUser(authorization));
  },
  rpc: (fn, args) => service.rpc(fn, args),
  client: (key) => splitwiseClient(key),
})));
