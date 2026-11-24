// Supabase Edge Function: sync-prices
//
// Today's exchange rates, a price snapshot for every
// stock/ETF, the owner's Coinbase balances (optional), then a price snapshot for every coin.
// No bank calls. Rates go first because both price steps convert with them; one step failing
// doesn't stop the others. Callers send a project secret key on the apikey header.

import { hasSecretKey } from "../_shared/secret-key.ts";
import { SECRET_KEYS, serviceClient } from "../_shared/clients.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { getJson, syncCrypto, syncFx, syncPortfolio } from "../_shared/prices.ts";
import { syncCoinbase } from "../_shared/coinbase.ts";

// Optional: without the key name and private key the Coinbase step is skipped (null in the result).
const COINBASE = {
  keyName: Deno.env.get("COINBASE_API_KEY_NAME"),
  privateKey: Deno.env.get("COINBASE_API_PRIVATE_KEY"),
  userId: Deno.env.get("COINBASE_USER_ID"),
};

const supabase = serviceClient();

// Stop pricing more holdings after this, so the crypto step still runs under the 150 s wall clock.
const PORTFOLIO_BUDGET_MS = 90000;

// A step's count, null when it was skipped (Coinbase not set up), "failed" when it threw (logged by tag only).
async function step(name: string, run: () => Promise<number | null>): Promise<number | null | "failed"> {
  try {
    return await run();
  } catch (err) {
    console.error(`sync-prices ${name} failed: ${errorTag(err)}`);
    return "failed";
  }
}

Deno.serve(async (req) => {
  const started = Date.now();
  if (!hasSecretKey(req, SECRET_KEYS)) return Response.json({ error: "secret key required" }, { status: 401 });
  const today = new Date().toISOString().slice(0, 10);
  const fx = await step("fx", () => syncFx(supabase, getJson));
  const portfolio = await step("portfolio", () => syncPortfolio(supabase, getJson, today, () => Date.now() - started < PORTFOLIO_BUDGET_MS));
  // Coinbase before the crypto step, so today's prices use today's balances.
  const coinbase = await step("coinbase", () => syncCoinbase(supabase, COINBASE));
  const crypto = await step("crypto", () => syncCrypto(supabase, getJson, today));
  const result = { fx, portfolio, coinbase, crypto, ms: Date.now() - started };
  console.log(`sync-prices: ${JSON.stringify(result)}`);
  const failed = [fx, portfolio, coinbase, crypto].includes("failed");
  return Response.json(result, { status: failed ? 500 : 200 });
});
