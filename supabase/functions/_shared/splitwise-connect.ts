// The splitwise-connect Edge Function's handler, apart from Deno.serve so it can be tested.
// POST { apiKey, consent: true }: asks Splitwise who the key belongs to, then stores the key in
// Vault and the connection (with the consent time) through splitwise_save_connection. 5 tries
// per 10 minutes per user.
// POST { disconnect: true, deleteData }: deletes the key and the connection; with deleteData,
// also what the sync brought in (splitwise_disconnect). The key never appears in a reply or log.
import { errorTag } from "./log-safe.ts";
import type { Reply } from "./origins.ts";
import { type CallerDeps, callerOrReply } from "./caller.ts";
import { personName, type SplitwiseClient, SplitwiseAuthError, SplitwiseProRequiredError, SplitwiseRateLimitError } from "./splitwise-api.ts";

const MAX_BODY = 16 * 1024;
// Splitwise keys are letters and digits; a little slack, never spaces.
const KEY_SHAPE = /^[A-Za-z0-9_-]{10,200}$/;

export type ConnectDeps = CallerDeps & {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>; // service role
  client(apiKey: string): Pick<SplitwiseClient, "currentUser">;
};

export const connectHandler = (deps: ConnectDeps) => async (req: Request, json: Reply): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerOrReply(req, deps, json, "splitwise-connect");
  if (userId instanceof Response) return userId;

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return json({ error: "Request too large" }, 413);
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(raw);
  } catch { /* not JSON */ }
  if (typeof body !== "object" || body === null) return json({ error: "Send your API key and consent" }, 400);

  if (body.disconnect === true) {
    const { data, error } = await deps.rpc("splitwise_disconnect", { p_user: userId, p_delete_data: body.deleteData === true });
    if (error) {
      console.error(`splitwise-connect: disconnect failed: ${errorTag(error)}`);
      return json({ error: "Couldn't disconnect Splitwise. Try again later." }, 500);
    }
    return json({ disconnected: true, deleted: (data as { deleted?: number } | null)?.deleted ?? 0 });
  }

  if (body.consent !== true) return json({ error: "Agree to let Alopex read your Splitwise expenses first" }, 400);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!KEY_SHAPE.test(apiKey)) return json({ error: "That doesn't look like a Splitwise API key" }, 400);
  // 5 key checks per 10 minutes per user, counted before Splitwise is asked (splitwise_attempt).
  const attempt = await deps.rpc("splitwise_attempt", { p_user: userId, p_kind: "connect", p_max: 5, p_window: "10 minutes" });
  if (attempt.error) {
    console.error(`splitwise-connect: attempt check failed: ${errorTag(attempt.error)}`);
    return json({ error: "Couldn't check the key right now. Try again later." }, 503);
  }
  if (attempt.data !== true) return json({ error: "Too many tries. Wait 10 minutes and try again." }, 429);

  let me;
  try {
    me = await deps.client(apiKey).currentUser();
  } catch (err) {
    console.error(`splitwise-connect: key check failed: ${errorTag(err)}`);
    if (err instanceof SplitwiseProRequiredError) {
      return json({ error: "This key's Splitwise account has no active Splitwise Pro subscription, which Splitwise requires for API keys. Import a Splitwise file instead.", code: "pro_required" }, 400);
    }
    if (err instanceof SplitwiseAuthError) return json({ error: "Splitwise did not accept this API key." }, 400);
    if (err instanceof SplitwiseRateLimitError) return json({ error: "Splitwise asked to slow down. Try again later." }, 429);
    return json({ error: "Couldn't reach Splitwise. Try again later." }, 502);
  }
  const displayName = personName(me) || `Splitwise user ${me.id}`;
  const { error } = await deps.rpc("splitwise_save_connection", {
    p_user: userId,
    p_key: apiKey,
    p_splitwise_user_id: me.id,
    p_display_name: displayName,
  });
  if (error) {
    console.error(`splitwise-connect: save failed: ${errorTag(error)}`);
    return json({ error: "Couldn't save the connection. Try again later." }, 500);
  }
  return json({ displayName });
};
