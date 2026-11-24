// The delete-account request handler, apart from Deno.serve so it can be tested.
import type { Reply } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { type CallerDeps, callerOrReply } from "../_shared/caller.ts";

type Answer<T> = PromiseLike<{ data: T; error: unknown }>;

export type DeleteAccountDeps = CallerDeps & {
  // The signed-in user's email, for the password check (service role).
  user(userId: string): Answer<{ user: { email?: string } | null }>;
  // A fresh sign-in with the typed password, kept apart from the caller's session.
  signIn(email: string, password: string): Answer<{ user: { id: string } | null }>;
  rpc(fn: string, args: Record<string, unknown>): Answer<unknown>; // service role
  sessionIds(userId: string): Answer<{ session_id: string }[] | null>; // service role
  deleteUser(userId: string): PromiseLike<{ error: unknown }>; // service role
  closeSessions(sessionIds: string[]): Promise<unknown>;
};

export const deleteAccountHandler = (deps: DeleteAccountDeps) => async (req: Request, json: Reply): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const userId = await callerOrReply(req, deps, json, "delete-account");
  if (userId instanceof Response) return userId;

  const body = await req.json().catch(() => null);
  if (body?.confirm !== "DELETE") return json({ error: "Type DELETE to confirm" }, 400);
  const password = body?.password;
  if (typeof password !== "string" || !password || password.length > 1024) {
    return json({ error: "Enter your password to confirm" }, 400);
  }
  const { data: userData, error: userError } = await deps.user(userId);
  if (userError) {
    console.error(`delete-account: user not read: ${errorTag(userError)}`);
    return json({ error: "Couldn't delete the account, please try again" }, 500);
  }
  const email = userData.user?.email;
  if (!email) return json({ error: "This account has no password to confirm with" }, 400);
  const { data: signedIn, error: passwordError } = await deps.signIn(email, password);
  if (passwordError || signedIn.user?.id !== userId) {
    return json({ error: "Wrong password" }, 403);
  }

  const { data: allowed, error: ownerError } = await deps.rpc("can_delete_user", { p_user: userId });
  if (ownerError) {
    console.error(`delete-account: owner check failed: ${errorTag(ownerError)}`);
    return json({ error: "Couldn't delete the account, please try again" }, 500);
  }
  if (!allowed) {
    return json({ error: "You set up this instance: remove the other users first" }, 409);
  }

  const { data: sessions, error: sessionsError } = await deps.sessionIds(userId);
  if (sessionsError) {
    console.error(`delete-account: sessions not read: ${errorTag(sessionsError)}`);
    return json({ error: "Couldn't delete the account, please try again" }, 500);
  }
  // Delete first: if it fails, the user keeps working banks. The session ids are already read.
  const { error } = await deps.deleteUser(userId);
  if (error) {
    console.error(`delete-account failed: ${errorTag(error)}`);
    return json({ error: "Couldn't delete the account, please try again" }, 500);
  }
  // Links made before bank_sessions existed have no stored session: those expire on their own
  // (at most 180 days) and can be revoked from the bank's own app meanwhile.
  await deps.closeSessions((sessions ?? []).map((s) => s.session_id)).catch((err) => {
    console.error(`delete-account: sessions not closed: ${errorTag(err)}`);
  });
  return json({ ok: true });
};
