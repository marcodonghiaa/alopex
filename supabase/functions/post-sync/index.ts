// Supabase Edge Function: post-sync
//
// What the launchd pipeline runs after the bank sync, moved into Supabase: merchant keys and
// alias dedupe for rows the sync didn't key (merchant-key-backfill.ts), categories for new
// rows (your rules, your past choices, then Gemini; port of categorize.js), then flow_type
// (spend / income / transfer, see flow.ts for the order), suggested transfer pairs between your own
// accounts (transfer-pairs.ts) and refund pairs (classify-flow.js). Categories go first: a row
// that takes Transfer from your past choices also becomes a transfer. Then transaction types
// (classify-type.js) and Splitwise shares (categorize-splitwise.js), then broker bank rows matched to
// your broker CSV (match_broker_rows). No bank calls, and every update only fills empty values (or moves AI
// rows to your choice, spend/income to refunded), so it is safe to run beside the launchd sync;
// the only cost is that both may send the same new rows to Gemini once.
// Callers send a project secret key on the apikey header, like sync-bank.

import { createClient } from "jsr:@supabase/supabase-js@2.119.0";
import { hasSecretKey, parseSecretKeys } from "../_shared/secret-key.ts";
import { retryRejectedToken } from "../_shared/postgrest-retry.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { classifyFlows, markRefunds } from "../_shared/flow.ts";
import { pairTransfers } from "../_shared/transfer-pairs.ts";
import { categorize, type Classify } from "../_shared/categorize.ts";
import { buildCategorizePrompt } from "../_shared/categorize-prompt.ts";
import { type Ask, classifyWithGemini } from "../_shared/gemini.ts";
import { classifyTypes } from "../_shared/classify-type.ts";
import { categorizeSplitwise } from "../_shared/splitwise.ts";
import { nextCatchUp } from "../_shared/catch-up.ts";
import { backfillFx } from "../_shared/fx-backfill.ts";
import { getJson } from "../_shared/prices.ts";
import { fillMerchantKeys } from "../_shared/merchant-key-backfill.ts";
import { runStep } from "../_shared/run-step.ts";

const SECRET_KEYS = parseSecretKeys(Deno.env.get("SUPABASE_SECRET_KEYS"));
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SECRET_KEYS.default ?? Object.values(SECRET_KEYS)[0] ?? "",
  { global: { fetch: retryRejectedToken(fetch) } },
);

// Without GEMINI_API_KEY only your rules and past choices categorize; the rest waits for a key.
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash-lite";
const ask: Ask | null = GEMINI_API_KEY
  ? (prompt, resultKey, resultEnum) =>
    classifyWithGemini({ prompt, resultKey, resultEnum, apiKey: GEMINI_API_KEY, model: GEMINI_MODEL })
  : null;
const classify: Classify | null = ask
  ? (rows, categories) => ask(buildCategorizePrompt(rows, categories), "category", categories)
  : null;

// Stop starting new batches after this: a batch started just before can still take a Gemini
// call (25 s) and the flow step, all under the 150 s wall clock. What's left waits for the next run.
const BUDGET_MS = 100000;
// The AI steps stop earlier, so a big backlog never starves the cheap flow and refund steps.
const AI_BUDGET_MS = 70000;

async function matchBrokerRows(): Promise<number> {
  const { data, error } = await supabase.rpc("match_broker_rows");
  if (error) console.error(`broker matching failed: ${errorTag(error)}`);
  return Number(data?.matched) || 0;
}

Deno.serve(async (req) => {
  const started = Date.now();
  if (!hasSecretKey(req, SECRET_KEYS)) return Response.json({ error: "secret key required" }, { status: 401 });
  const timeLeft = () => Date.now() - started < BUDGET_MS;
  const aiTimeLeft = () => Date.now() - started < AI_BUDGET_MS;

  try {
    // Past exchange rates first: a fresh install has none before today (e2e #8). Best effort.
    const fxBackfilled = await backfillFx(supabase, getJson).catch((err) => (console.error(`fx backfill failed: ${errorTag(err)}`), 0));
    // Each step on its own: one that throws is logged and makes the run a 500, the rest still run.
    const stepsFailed: string[] = [];
    const keys = timeLeft() ? await runStep("merchantKeys", stepsFailed, () => fillMerchantKeys(supabase, timeLeft), { keys: 0, aliases: 0 }) : { keys: 0, aliases: 0 };
    const categories = await runStep("categorize", stepsFailed, () => categorize(supabase, classify, aiTimeLeft), { categorized: 0, relearned: 0, byRules: 0, aiFailed: false });
    const types = await runStep("types", stepsFailed, () => classifyTypes(supabase, ask, aiTimeLeft), { typed: 0, typedByRules: 0, typeAiFailed: false });
    const splitwise = await runStep("splitwise", stepsFailed, () => categorizeSplitwise(supabase, ask, aiTimeLeft), { splitwise: 0, splitwiseAiFailed: false });
    const flows = await runStep("flows", stepsFailed, () => classifyFlows(supabase, timeLeft), { total: 0, stuck: false, reresolved: 0 });
    const transferPairs = await runStep("transferPairs", stepsFailed, () => pairTransfers(supabase, timeLeft), 0);
    const refunds = timeLeft() ? await runStep("refunds", stepsFailed, () => markRefunds(supabase), { pairs: 0, failed: 0 }) : { pairs: 0, failed: 0 };
    // Last, so transfer pairs are already there: broker bank rows (date + amount only) get the
    // broker CSV row they came from (20261220000000_broker_matching). Best effort.
    const brokerMatched = await runStep("brokerMatching", stepsFailed, () => matchBrokerRows(), 0);
    const result = { fxBackfilled, ...keys, ...categories, ...types, ...splitwise, flows: flows.total, flowsReresolved: flows.reresolved, transferPairs, refunds: refunds.pairs, brokerMatched, refundWritesFailed: refunds.failed, stuck: flows.stuck, ms: Date.now() - started };
    console.log(`post-sync: ${JSON.stringify(result)}`);
    // After a first sync, rounds follow each other until nothing is left (_shared/catch-up.ts).
    const round = Number((await req.json().catch(() => ({})))?.catch_up) || 0;
    const next = nextCatchUp(round, { ...result, splitwise: result.splitwise ?? 0 });
    if (next) {
      const { error } = await supabase.rpc("queue_edge_job", { job: next.job, round: next.round });
      if (error) console.error(`catch-up round ${round + 1} not queued: ${errorTag(error)}`);
    }
    const failed = stepsFailed.length > 0 || flows.stuck || refunds.failed > 0 || categories.aiFailed || types.typeAiFailed || splitwise.splitwiseAiFailed;
    return Response.json(result, { status: failed ? 500 : 200 });
  } catch (err) {
    console.error(`post-sync failed: ${errorTag(err)}`);
    return Response.json({ error: "post-sync failed" }, { status: 500 });
  }
});
