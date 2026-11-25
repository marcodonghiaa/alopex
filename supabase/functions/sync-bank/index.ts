// Supabase Edge Function: sync-bank
//
// Balance and transactions for ONE account per call, so a
// slow bank can't push the whole run past the 150 s wall clock. Body: { "account_uid": "..." }.
// Only our own backend may call it, with a project secret key on the apikey header (pg_cron
// fans out one call per account): every call spends Enable Banking requests, and banks allow
// ~4 unattended calls a day per account. verify_jwt is off: secret keys are not JWTs.

import { signEnableBankingJwt } from "../_shared/enable-banking.ts";
import { SECRET_KEYS, serviceClient } from "../_shared/clients.ts";
import { syncBankHandler } from "./handler.ts";

// A project without secret keys (Settings -> API Keys) gets 401 on every call: create them first.
Deno.serve(syncBankHandler({ supabase: serviceClient(), secretKeys: SECRET_KEYS, sign: signEnableBankingJwt }));
