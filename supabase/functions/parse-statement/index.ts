// Supabase Edge Function: parse-statement
//
// Reads the transactions out of a bank statement PDF for the dashboard's import:
// { pdf: <base64> } -> { rows: [{ date, description, amount, direction }] }.
// The PDF goes to Gemini (the same API the categorizer uses) and is never stored. Nothing is
// written here: the dashboard shows the rows, leaves out ones already imported, and adds the
// rest with add_manual_transaction once you confirm.
//
// Requires a signed-in user, or this is an open proxy to Gemini on your key, and allows each
// user 10 PDF reads per 10 minutes.
// Secret: GEMINI_API_KEY (and optionally GEMINI_MODEL).

import { serveWithCors } from "../_shared/origins.ts";
import { serviceClient, userCaller } from "../_shared/clients.ts";
import { callerOrReply } from "../_shared/caller.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { geminiRequest, parseStatementRequest, statementAttemptRefusal, statementReply } from "../_shared/statement-pdf.ts";
import { DEFAULT_GEMINI_MODEL, geminiFetch } from "../_shared/gemini.ts";

const TIMEOUT_MS = 90_000;
const service = serviceClient();

Deno.serve(serveWithCors(async (req, json) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const userId = await callerOrReply(req, userCaller, json, "parse-statement");
  if (userId instanceof Response) return userId;

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return json({ error: "PDF import needs the GEMINI_API_KEY secret on the Edge Functions" }, 503);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = parseStatementRequest(body);
  if (typeof parsed === "string") return json({ error: parsed }, 400);
  // Counted only for well-formed requests, right before the Gemini call (migration 20270113000000).
  const limited = await statementAttemptRefusal((fn, args) => service.rpc(fn, args), userId);
  if (limited) return json({ error: limited.error }, limited.status);

  const model = Deno.env.get("GEMINI_MODEL") || DEFAULT_GEMINI_MODEL;
  let res: Response;
  try {
    res = await geminiFetch(geminiRequest(parsed.pdf), apiKey, model, TIMEOUT_MS);
  } catch (err) {
    console.error(`Gemini did not answer: ${errorTag(err)}`);
    return json({ error: "The AI didn't answer in time, try a shorter statement" }, 504);
  }
  if (!res.ok) {
    // The body can quote the request; keep it out of the browser and the log.
    console.error(`Gemini error ${res.status}`);
    return json({ error: `The AI couldn't read this PDF (error ${res.status})` }, 502);
  }
  const reply = await statementReply(res);
  return json(reply.body, reply.status);
}));
