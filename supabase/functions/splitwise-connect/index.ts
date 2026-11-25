// Supabase Edge Function: splitwise-connect
//
// The dashboard's Splitwise connection. POST { apiKey, consent: true } checks the personal API key
// with Splitwise and stores it in Supabase Vault (never in a table column), returning
// { displayName }. POST { disconnect: true, deleteData } deletes the key and the connection, and
// with deleteData what the sync brought in. Signed-in users only, after two-step sign-in
// (verify_jwt = true). The work is in _shared/splitwise-connect.ts.

import { serveWithCors } from "../_shared/origins.ts";
import { splitwiseClient } from "../_shared/splitwise-api.ts";
import { connectHandler } from "../_shared/splitwise-connect.ts";
import { serviceClient, userCaller } from "../_shared/clients.ts";

const service = serviceClient();

Deno.serve(serveWithCors(connectHandler({
  ...userCaller,
  rpc: (fn, args) => service.rpc(fn, args),
  client: (key) => splitwiseClient(key),
})));
