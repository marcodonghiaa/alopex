// The reapply-rules request handler, apart from Deno.serve so it can be tested.
import type { Db } from "../_shared/batch-update.ts";
import type { Reply } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { type CallerDeps, callerOrReply } from "../_shared/caller.ts";
import { PartialApplyError, reapplyRules } from "../_shared/reapply-rules.ts";
import type { Rule } from "../_shared/rules.ts";

const FIELDS = ["creditor_name", "remittance_info", "any"];
const MODES = ["contains", "word", "exact"];
// Rules from before the 200-character cap can be longer; this only bounds the body (characters).
const MAX_TEXT = 2000;
const MAX_BODY = 16 * 1024;

// { retired: rule } after a delete: the rule's own fields, checked like the table checks them.
// undefined when absent, null when malformed. user_id is never taken from the body.
export function retiredFrom(body: unknown): Rule | null | undefined {
  // deno-lint-ignore no-explicit-any
  const r = (body as any)?.retired;
  if (r === undefined || r === null) return undefined;
  const ok = typeof r === "object" &&
    FIELDS.includes(r.match_field) &&
    typeof r.match_text === "string" && [...r.match_text].length <= MAX_TEXT &&
    (r.match_mode == null || MODES.includes(r.match_mode)) &&
    typeof r.set_category === "string" && r.set_category.length > 0 && [...r.set_category].length <= MAX_TEXT;
  if (!ok) return null;
  return { user_id: "", match_field: r.match_field, match_text: r.match_text, match_mode: r.match_mode ?? "contains", set_category: r.set_category };
}

export interface Deps extends CallerDeps {
  admin(): Db; // service-role client: the user's own JWT would trip the hand-edit trigger
}

export const reapplyHandler = (deps: Deps) => async (req: Request, json: Reply): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await callerOrReply(req, deps, json, "reapply-rules");
  if (userId instanceof Response) return userId;

  // The real body is a few hundred bytes: refuse a large one before reading or parsing it.
  if (Number(req.headers.get("Content-Length") ?? 0) > MAX_BODY) return json({ error: "Request too large" }, 413);
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return json({ error: "Request too large" }, 413);
  let body = null; // anything but { apply: true } is a preview
  try {
    body = JSON.parse(raw);
  } catch { /* not JSON: a preview */ }
  const retired = retiredFrom(body);
  if (retired === null) return json({ error: "That rule can't be checked" }, 400);
  try {
    return json(await reapplyRules(deps.admin(), userId, body?.apply === true, retired));
  } catch (err) {
    console.error(`reapply-rules failed: ${errorTag(err)}`);
    const error = err instanceof PartialApplyError
      ? "Some transactions couldn't be updated. Try again: the ones already updated stay as they are."
      : "Couldn't apply your rules, please try again";
    return json({ error }, 500);
  }
};
