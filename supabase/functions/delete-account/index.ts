// Supabase Edge Function: delete-account
//
// Deletes the signed-in user and everything stored for them on this instance, then closes
// their Enable Banking sessions so their banks stop sharing data.
// Body: { "confirm": "DELETE", "password": "..." }. The password is checked again here, so a
// stolen session token alone can't erase an account.
// Every row that belongs to the user goes with them (foreign keys cascade from auth.users,
// migration 20261125000000). The Enable Banking key and the instance settings are untouched.

import { createClient } from "jsr:@supabase/supabase-js@2.119.0";
import { serveWithCors } from "../_shared/origins.ts";
import { asUser } from "../_shared/clients.ts";
import { closeSessions } from "../_shared/eb-sessions.ts";
import { deleteAccountHandler } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(serveWithCors(deleteAccountHandler({
  asUser,
  signIn: (email, password) =>
    createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } })
      .auth.signInWithPassword({ email, password }),
  rpc: (fn, args) => service.rpc(fn, args),
  sessionIds: (userId) => service.from("bank_sessions").select("session_id").eq("user_id", userId),
  deleteUser: (userId) => service.auth.admin.deleteUser(userId),
  closeSessions: (ids) => closeSessions(ids),
})));
