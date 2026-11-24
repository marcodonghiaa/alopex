// Supabase Edge Function: delete-account
//
// Deletes the signed-in user and everything stored for them on this instance, then closes
// their Enable Banking sessions so their banks stop sharing data.
// Body: { "confirm": "DELETE", "password": "..." }. The password is checked again here, so a
// stolen session token alone can't erase an account.
// Every row that belongs to the user goes with them (foreign keys cascade from auth.users,
// migration 20261125000000). The Enable Banking key and the instance settings are untouched.

import { serveWithCors } from "../_shared/origins.ts";
import { serviceClient, signInClient, userCaller } from "../_shared/clients.ts";
import { closeSessions } from "../_shared/eb-sessions.ts";
import { deleteAccountHandler } from "./handler.ts";

const service = serviceClient();

Deno.serve(serveWithCors(deleteAccountHandler({
  ...userCaller,
  user: (userId) => service.auth.admin.getUserById(userId),
  signIn: (email, password) =>
    signInClient().auth.signInWithPassword({ email, password }),
  signOut: (accessToken) => service.auth.admin.signOut(accessToken, "local"),
  rpc: (fn, args) => service.rpc(fn, args),
  sessionIds: (userId) => service.from("bank_sessions").select("session_id").eq("user_id", userId),
  accountSessionIds: (userId) =>
    service.from("accounts").select("bank_session_id").eq("user_id", userId).not("bank_session_id", "is", null),
  deleteUser: (userId) => service.auth.admin.deleteUser(userId),
  closeSessions: (ids) => closeSessions(ids),
})));
