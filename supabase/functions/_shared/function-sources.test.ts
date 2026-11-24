import { assertEquals } from "jsr:@std/assert@1.0.19";
// Reads the functions' own source (text imports need no --allow-read): rules that keep one copy of
// the sign-in check and of the key lookup. A new function's files belong in SOURCES.
import addHolding from "../add-holding/index.ts" with { type: "text" };
import bankConsentCallback from "../bank-consent-callback/index.ts" with { type: "text" };
import completeBankConsent from "../complete-bank-consent/index.ts" with { type: "text" };
import deleteAccount from "../delete-account/index.ts" with { type: "text" };
import deleteAccountHandler from "../delete-account/handler.ts" with { type: "text" };
import detectRecurring from "../detect-recurring/index.ts" with { type: "text" };
import listBanks from "../list-banks/index.ts" with { type: "text" };
import notify from "../notify/index.ts" with { type: "text" };
import parseStatement from "../parse-statement/index.ts" with { type: "text" };
import postSync from "../post-sync/index.ts" with { type: "text" };
import reapplyRules from "../reapply-rules/index.ts" with { type: "text" };
import reapplyRulesHandler from "../reapply-rules/handler.ts" with { type: "text" };
import refreshRecurring from "../refresh-recurring/index.ts" with { type: "text" };
import refreshRecurringHandler from "../refresh-recurring/handler.ts" with { type: "text" };
import splitwiseConnect from "../splitwise-connect/index.ts" with { type: "text" };
import startBankConsent from "../start-bank-consent/index.ts" with { type: "text" };
import syncBank from "../sync-bank/index.ts" with { type: "text" };
import syncPrices from "../sync-prices/index.ts" with { type: "text" };
import syncSplitwise from "../sync-splitwise/index.ts" with { type: "text" };
import splitwiseConnectJob from "./splitwise-connect.ts" with { type: "text" };
import splitwiseSyncJob from "./splitwise-sync-job.ts" with { type: "text" };
import origins from "./origins.ts" with { type: "text" };

const SOURCES: Record<string, string> = {
  "add-holding/index.ts": addHolding,
  "bank-consent-callback/index.ts": bankConsentCallback,
  "complete-bank-consent/index.ts": completeBankConsent,
  "delete-account/index.ts": deleteAccount,
  "delete-account/handler.ts": deleteAccountHandler,
  "detect-recurring/index.ts": detectRecurring,
  "list-banks/index.ts": listBanks,
  "notify/index.ts": notify,
  "parse-statement/index.ts": parseStatement,
  "post-sync/index.ts": postSync,
  "reapply-rules/index.ts": reapplyRules,
  "reapply-rules/handler.ts": reapplyRulesHandler,
  "refresh-recurring/index.ts": refreshRecurring,
  "refresh-recurring/handler.ts": refreshRecurringHandler,
  "splitwise-connect/index.ts": splitwiseConnect,
  "start-bank-consent/index.ts": startBankConsent,
  "sync-bank/index.ts": syncBank,
  "sync-prices/index.ts": syncPrices,
  "sync-splitwise/index.ts": syncSplitwise,
  "_shared/splitwise-connect.ts": splitwiseConnectJob,
  "_shared/splitwise-sync-job.ts": splitwiseSyncJob,
  "_shared/origins.ts": origins,
};

const offenders = (pattern: RegExp) => Object.keys(SOURCES).filter((f) => pattern.test(SOURCES[f]));

Deno.test("the sign-in and two-step check is callerOrReply's alone (_shared/caller.ts)", () => {
  assertEquals(offenders(/auth\.getUser\(|mfaRefusal\(/), []);
});

Deno.test("no function reads the legacy keys itself: clients.ts picks the secret or publishable key first", () => {
  assertEquals(offenders(/SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY/), []);
});

// H165: claimConsent's burn (the caller's own expired link) must reach burnCode, not only a
// state that belongs to someone else.
Deno.test("complete-bank-consent burns the code of an expired link too", () => {
  assertEquals(/if \(claim\.burn \|\| foreign\) await burnCode\(body\.code\)/.test(completeBankConsent), true);
});
