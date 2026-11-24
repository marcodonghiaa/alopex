// The complete-bank-consent request handler, apart from Deno.serve so it can be tested (see index.ts).
import type { Db } from "../_shared/batch-update.ts";
import type { Reply } from "../_shared/origins.ts";
import { type CallerDeps, callerOrReply } from "../_shared/caller.ts";
import type { linkAccounts } from "../_shared/link-accounts.ts";
import { claimConsent, isConsentInput } from "../_shared/consent-claim.ts";

export interface Deps extends CallerDeps {
  asUser(authorization: string): Db; // the caller's own session: RLS finds only their pending row
  service: Db;
  linkAccounts(userId: string, code: string): ReturnType<typeof linkAccounts>;
  burnCode(code: string): Promise<void>;
  afterLink(syncUids: string[]): void; // the first sync, started without holding the reply
}

export const completeHandler = (deps: Deps) => async (req: Request, json: Reply): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const userId = await callerOrReply(req, deps, json, "complete-bank-consent");
  if (userId instanceof Response) return userId;
  const asUser = deps.asUser(req.headers.get("Authorization")!);

  const body = await req.json().catch(() => null);
  if (!isConsentInput(body)) return json({ error: "Missing code or state" }, 400);

  const claim = await claimConsent(asUser, body.state, userId, Date.now());
  if ("error" in claim) {
    if (claim.transient) return json({ error: claim.error }, 503);
    // The caller's own link expired (claim.burn), or the state is someone else's (the link was
    // started by another user): close the code, so it can't be paired with another state. A state
    // that doesn't exist costs no bank call.
    const foreign = !claim.burn && (await deps.service
      .from("pending_bank_consents").select("id").eq("id", body.state).maybeSingle()).data;
    if (claim.burn || foreign) await deps.burnCode(body.code);
    return json({ error: claim.error }, 403);
  }

  const result = await deps.linkAccounts(userId, body.code);
  if ("error" in result) return json({ error: result.error }, 502);

  // Transactions now, not at the next cron run; the reply does not wait for it.
  deps.afterLink(result.syncUids);
  return json(result.params);
};
