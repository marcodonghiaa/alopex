# Upgrading

Pulling new code does not update your database. Migrations are not applied automatically, and the Edge Functions only change once you redeploy them. `npx create-alopex@latest` does all of it; the steps below are for updating by hand. Find your version below and do what each change asks.

For every release: `git pull`, then `supabase db push --linked` for new migrations (keep `--linked`: since Supabase CLI v3 a plain `db push` targets a local database, not your project), then `supabase functions deploy` for changed functions.

To roll a change back: run its file from `supabase/rollbacks/` in the Supabase SQL editor (or with `psql`), then `supabase migration repair --status reverted <version> --linked` (the version is the number at the start of the file name). Without the repair, a later `supabase db push --linked` still counts the migration as applied and does not bring it back.

## Release notes, newest first

## Unreleased

### Steadier prices, Splitwise, notifications and post-sync
- **Deploy:** `supabase functions deploy` (sync-prices, sync-splitwise, notify, parse-statement, post-sync, detect-recurring, refresh-recurring). No migration of its own (sync-splitwise uses `20270121000000_splitwise_last_attempt`, below, and runs the old order without it). No dashboard change.
- What changes: Coinbase crypto now counts funds on hold in open orders and adds up every account of a coin, and a coin's other account at zero no longer sets it to zero. The price sync reads each exchange rate once per run, and prices the holdings not yet priced today first and sold ones (0 shares) last, so when it runs out of time a different part waits each run. Splitwise groups with the same name keep their names whatever order Splitwise lists them in (the oldest keeps the plain name; if yours were the other way round, shares follow the new names as they sync and the weekly full read). The weekly Splitwise check reads up to 10 missing expenses once more before removing them, so one the paging skipped is kept. A notification the push service refuses with 403 (its VAPID check failed: push keys other than the ones the device subscribed with, for example after a reinstall that made new ones) now logs "check that VAPID_* are the keys the devices subscribed with" and keeps the subscription, so putting the old keys back brings every device back. A PDF import whose AI answer can't be read says so instead of failing with a network error. Rules, merchant names and subscription detection read every row past the first 1000. A catch-up round after a first sync counts only rows the AI filled, so a batch it can't fill is not sent again for 10 rounds. Bank names with a double quote or backslash are left out of the "your past choice" lookup (they go to the AI). Subscription detection counts a payment not yet given a flow as spending, as every page already does.
- **Roll back:** deploy the previous functions.

### Splitwise: a sync that never finishes no longer holds up everyone after it
- **Migration:** `20270121000000_splitwise_last_attempt`. Apply it with `supabase db push --linked`, best before `supabase functions deploy` (sync-splitwise). Deployed first, the new function logs "last_attempt_at missing, run supabase db push" and keeps the old order until the column exists.
- What changes: the scheduled Splitwise sync now notes when it last tried each connection and starts with the one tried longest ago. Before, a user whose sync was cut off by the time limit stayed first on every run, so if it always ran out of time, connections after it never synced. Nothing changes for a sync that finishes.
- **Roll back:** deploy the previous sync-splitwise, then run `supabase/rollbacks/20270121000000_splitwise_last_attempt.down.sql`, then `supabase migration repair --status reverted 20270121000000 --linked`.

### Sturdier account deletion, origin check and installer
- **Deploy:** `supabase functions deploy` (delete-account, and every dashboard-facing function for the origin check). No migration of its own. The installer changes reach you with the next `npx create-alopex@latest`.
- What changes: deleting your account no longer leaves behind the extra session its password check opened when the delete is refused or fails. A failed lookup of the dashboard addresses is logged with its error code only, never the message. The installer now asks for a login password of at least 12 characters and raises Supabase Auth's minimum password length to 12 when it is lower (a higher one you set stays), so a reset or change can't go shorter (your current password keeps working, whatever its length). It unpacks each release in a private temporary folder and installs the backend packages without running install scripts.
- **Optional, the scheduled sync's own key:** in Supabase, Project Settings -> API Keys, add a secret key named `cron`, then run `npx create-alopex@latest` again. The sync then stores that key in Vault instead of your main secret key, so you can revoke or rotate it alone. By hand: put it in the Vault secret `sync_bank_secret_key` (see `20261117000000_sync_all_banks.sql`).
- **Roll back:** deploy the previous functions.

### Undoing a payback puts back what it changed
- **Migration:** `20270120000000_payback_undo_restores`. Apply it with `supabase db push --linked`. No function or dashboard change.
- What changes: when you undo an "Is this Anna?" answer and also unlink the payer, a link that answer had replaced (the payer was linked to someone else before) comes back instead of being deleted. A payment you had marked as income by hand is income again after the undo; one the app had classified goes back to the app, as before. A payment reference stored on a settled bill can be at most 1000 characters (a longer one, which can't be a bank reference, is cleared; the bill stays settled). Paybacks recorded before this release undo as before.
- **Roll back:** run `supabase/rollbacks/20270120000000_payback_undo_restores.down.sql`, then `supabase migration repair --status reverted 20270120000000 --linked`.

### The bank-field guard can't be switched off by a session
- **Migration:** `20270119000000_broker_flag_definer_only`. Apply it with `supabase db push --linked`. No function or dashboard change.
- What changes: nothing you can see. The guard that stops a signed-in user from rewriting bank fields, and the marks for categories and flows you set by hand, stood aside whenever the session setting `alopex.broker_match` was on. That setting now counts only inside the database's own broker matching and category move, never when a user's session sets it itself.
- **If you redefined `restrict_transaction_updates`, `mark_manual_category` or `flow_source_user` in a migration of your own**, start from the versions in this migration: they no longer check the setting themselves (the triggers do).
- **Roll back:** run `supabase/rollbacks/20270119000000_broker_flag_definer_only.down.sql`, then `supabase migration repair --status reverted 20270119000000 --linked`.

### Push subscriptions must be real browser endpoints
- **Migration:** `20270118000000_push_subscription_checks`. Apply it with `supabase db push --linked`, then `supabase functions deploy notify`. No dashboard change.
- What changes: a push subscription saved straight into the database (older dashboards did that) must now pass the same checks as turning check-ins on in the current dashboard: an `https://` endpoint and well-formed keys. Both now also refuse an endpoint whose host is an IP address, `localhost` (or a name ending in `.localhost`), a name without a dot, or one with user info, so the notify job can't be pointed at a machine on your network by address. The notify job skips such an endpoint too. A name that resolves to a private address still passes. A stored one that fails them could never receive a notification and is deleted; if that was yours, turn purchase check-ins on again.
- **Roll back:** run `supabase/rollbacks/20270118000000_push_subscription_checks.down.sql`, then `supabase migration repair --status reverted 20270118000000 --linked`.

### Category names and bank-link origins have a length cap
- **Migration:** `20270117000000_user_text_length_caps`. Apply it with `supabase db push --linked`. No function or dashboard change.
- What changes: a category you set on a transaction can be at most 100 characters, as for manual transactions already (checked only when you set or change it; a longer one stored before stays, and the sync and your rules are never refused). An unfinished bank link whose stored origin is longer than 300 characters (only possible by writing to the database directly) is deleted, and new ones are capped at 300.
- **Roll back:** run `supabase/rollbacks/20270117000000_user_text_length_caps.down.sql`, then `supabase migration repair --status reverted 20270117000000 --linked`.

### Trades refuse impossible numbers
- **Migration:** `20270116000000_holding_trades_finite`. Apply it with `supabase db push --linked`. No function or dashboard change.
- What changes: a trade's shares, price and fee must be real numbers; `NaN` and `Infinity` are refused, as holdings already refuse them. Trades you stored before are not checked; one with such a number has to be fixed or deleted before you can edit it again.
- **Roll back:** run `supabase/rollbacks/20270116000000_holding_trades_finite.down.sql`, then `supabase migration repair --status reverted 20270116000000 --linked`.

### Six database functions search temporary tables last
- **Migration:** `20270115000000_definer_search_path_pg_temp`. Apply it with `supabase db push --linked`. No function or dashboard change.
- What changes: nothing you can see. `add_manual_debt`, `add_manual_transaction`, `set_account_type`, `set_holding_quantity`, `set_manual_balance` and `upsert_detected_streams` now look up tables in `public` and only then in a session's temporary tables, like the newer functions, so a temporary table can never stand in for a real one inside them.
- **Roll back:** run `supabase/rollbacks/20270115000000_definer_search_path_pg_temp.down.sql`, then `supabase migration repair --status reverted 20270115000000 --linked`.

### Sync cursors are server-only
- **Migration:** `20270114000000_sync_cursors_server_only`. Apply it with `supabase db push --linked`. No function or dashboard change.
- What changes: nothing you can see. `sync_cursors` (where each account's sync got to) no longer carries Supabase's default grants to `anon` and `authenticated`, like the other server-only tables, so it stays closed even if row level security is ever turned off. The sync uses the service role and is not affected.
- **Roll back:** run `supabase/rollbacks/20270114000000_sync_cursors_server_only.down.sql`, then `supabase migration repair --status reverted 20270114000000 --linked`.

### PDF import has a per-user limit
- **Migration:** `20270113000000_statement_attempts`. Apply it with `supabase db push --linked` first, then `supabase functions deploy parse-statement`. No dashboard change.
- What changes: each user can import up to 10 PDF statements per 10 minutes; the 11th answers "Too many PDF imports. Wait 10 minutes and try again." This stops one account (or a stolen session) from spending your Gemini quota in a loop.
- **Roll back:** deploy the previous `parse-statement` first, then run `supabase/rollbacks/20270113000000_statement_attempts.down.sql`, then `supabase migration repair --status reverted 20270113000000 --linked`.

### Bank linking and sync are sturdier
- **Deploy:** `supabase functions deploy` (sync-bank, complete-bank-consent, start-bank-consent, list-banks, delete-account). No migration, no dashboard change.
- What changes: when one account of a bank link can't be saved, the others are still linked and synced right away, instead of the whole link failing. A bank whose account details never carry an identification hash is no longer asked for them on every sync. A bank that keeps sending the same next-page key stops the sync at once with `PAGING_LOOP` (pages read are saved, the next sync tries again) instead of running into `TIMEOUT`. A first sync that ran out of time but saved transactions gets them categorised right away. An expired bank link's code is closed at Enable Banking. Enable Banking calls while linking, and the bank list, give up after 15 seconds. Deleting your account also closes bank sessions only your accounts remembered. New transactions keep only the other party's name in the stored bank payload (no address, ids, bank or ultimate parties); rows stored before keep theirs.
- **Roll back:** deploy the previous functions.

### Edge Functions share one sign-in check and one key choice
- **Deploy:** `supabase functions deploy` (all functions). No migration of its own.
- What changes: when Supabase Auth itself is unreachable, linking a bank, the bank list, finishing a bank link, deleting the account, PDF import and adding a holding now answer 503 "Sign-in check is unavailable, please try again" instead of 401 "Not signed in". Every function now picks the project's secret key and publishable key first and falls back to the legacy service_role and anon keys, so turning the legacy keys off no longer breaks bank linking, Splitwise connect, account deletion, rules, subscription refresh or the dashboard origin check.
- **Roll back:** deploy the previous functions.

### Merchant names for older transactions are chosen by the database
- **Migration:** `20270112000000_merchant_alias_on_key_update`. Apply it with `supabase db push --linked` first, then `supabase functions deploy post-sync`. No dashboard change.
- What changes: nothing you can see. When post-sync fills in the merchant of a transaction stored before the sync did that, the name you gave that merchant now comes from the same database rule as for new transactions (your name for that exact bank name first, else your newest name for the merchant, never by merchant for PayPal, Apple or Google) instead of a copy of it in the function. Apple, PayPal and Google names given for one price now also follow that price on these rows, as they already did on new ones.
- **Roll back:** run `supabase/rollbacks/20270112000000_merchant_alias_on_key_update.down.sql`, then `supabase migration repair --status reverted 20270112000000 --linked`, and deploy the previous `post-sync`.

### The bank sync cron shares one Edge Function caller
- **Migration:** `20270111000000_sync_all_banks_uses_call_edge_function`. Apply it with `supabase db push --linked`. No function or dashboard change.
- What changes: nothing you can see. `sync_all_banks` sends each bank account through `call_edge_function`, like the other cron jobs, instead of keeping its own copy of the Vault secrets, headers and timeout. It still stops with "Set the Vault secrets ..." when they are missing.
- **Roll back:** run `supabase/rollbacks/20270111000000_sync_all_banks_uses_call_edge_function.down.sql`, then `supabase migration repair --status reverted 20270111000000 --linked`.

### New transaction columns are server-only by default
- **Migration:** `20270110000000_transactions_update_allowlist`. Apply it with `supabase db push --linked`. No function or dashboard change.
- **If you added your own column to `transactions`** (outside these migrations) that changes on every update, such as an `updated_at` set by a trigger, dashboard edits are now refused. Drop that column, or add it to the allowed list in a migration of your own that redefines the guard function.
- What changes: nothing you can see. The guard on transactions now lists what a signed-in user may change (category, name, flow, split, note, tags and the like, plus amount, date and name on manual accounts) instead of what they may not, so a column a later release adds can only be written by the sync until it is allowed on purpose. Every column that exists today keeps its old rule.
- **Roll back:** run `supabase/rollbacks/20270110000000_transactions_update_allowlist.down.sql`, then `supabase migration repair --status reverted 20270110000000 --linked`.

### Some Vercel dashboard addresses were refused
- **Migration:** `20270109000000_dashboard_origin_hosts`. Apply it with `supabase db push --linked`. No function or dashboard change.
- What changes: a dashboard address like `https://alopex-christina-projects.vercel.app` (any 9-letter part, common with Vercel's `<name>s-projects` addresses) was mistaken for a one-off deployment address and never allowed, so bank linking failed with a CORS error. It is now accepted on your next sign-in. One-off deployment addresses (a 9-character code mixing letters and digits) and branch addresses (`-git-`) are still refused.
- **Roll back:** run `supabase/rollbacks/20270109000000_dashboard_origin_hosts.down.sql`, then `supabase migration repair --status reverted 20270109000000 --linked`.

### The export leaves out an always-empty column
- **No migration, update the dashboard.** `net_worth.csv` in Settings -> Your data no longer has the `eur_equivalent` column: nothing ever wrote `net_worth_snapshots.eur_equivalent`, so it was always empty (euro values are in `v_net_worth_eur.amount_eur`). The column stays in the database, deprecated, and is still in `data.json`; a later release drops it.

### The unused deposits view is removed
- **Migration:** `20270108000000_drop_v_cd_holdings`. Apply it with `supabase db push --linked`, then update the dashboard. No function change.
- What changes: nothing you can see. Deposits (CDs) left the app in v0.2; the `v_cd_holdings` view nothing read is dropped (a view holds no data). The `cd_holdings` table and your rows stay, marked deprecated, and are still in Settings -> Your data. A later release drops the table, so download your data if you still want those rows.
- **Roll back:** run `supabase/rollbacks/20270108000000_drop_v_cd_holdings.down.sql`, then `supabase migration repair --status reverted 20270108000000 --linked`.

### Investment returns no longer read the old price history
- **Migration:** `20270107000000_holding_performance_no_price_history`. Apply it with `supabase db push --linked`. No function or dashboard change.
- What changes: investment returns use only your own price snapshots. Nothing has filled `price_history` since `backfill-price-history.js` left the sync, so on most installs nothing changes. If you ran that script back then, a range that starts before a holding's first snapshot now shows "since" (from the first snapshot) instead of a price from those old rows.
- `price_history` and its rows stay, marked deprecated; a later release drops the table.
- **Roll back:** run `supabase/rollbacks/20270107000000_holding_performance_no_price_history.down.sql`, then `supabase migration repair --status reverted 20270107000000 --linked`.

### One euro rate lookup for views and functions
- **Migration:** `20270106000000_fx_rate_to_eur`. Apply it with `supabase db push --linked`. No function or dashboard change.
- What changes: nothing you can see. It adds `fx_rate_to_eur(currency, date)` (the latest rate on or before the date, 1 for EUR), which views and functions switch to as they are next replaced.
- **Roll back:** run `supabase/rollbacks/20270106000000_fx_rate_to_eur.down.sql` (after rolling back any later migration that uses it), then `supabase migration repair --status reverted 20270106000000 --linked`.

### Rules match the same way in the sync and the dashboard
- **No migration, deploy functions:** `supabase functions deploy`. The sync now ignores accents and apostrophes in rule text, like the dashboard already did: a rule "cafe" now also sorts "CAFÉ ROMA". An apostrophe is no longer a word break, so a whole-word rule "mcdonald" stops matching "McDonald's" in the sync (the dashboard already worked this way); write the rule as "mcdonalds" or use "contains".

### Changing the password asks the server to check the current one
- **One setting to turn on (no migration, no function change):** in your Supabase project, **Authentication -> Sign In / Providers -> Email**, turn on *Require current password when changing password*, then update the dashboard. The dashboard now sends the current password with every change; with the setting on, Supabase refuses a change without it, so a copied login token alone can't set a new password. Supabase should still let a password-reset link set a new password without it: after turning the setting on, try *Forgot password* once, and if the reset page refuses, turn the setting off again (the dashboard still checks the current password in the browser). Leave *Secure password change* (reauthentication) as it is: the dashboard has no step for its emailed code.
- **Roll back:** turn the setting off.

### Undo of a removed subscription brings it back as it was
- **Migration:** `20270105000000_stream_undo_keeps_status`. Apply it with `supabase db push --linked`, then update the dashboard. No function change.
- What changes: Undo or Restore of a subscription you had confirmed brings it back to your subscriptions, not to "To review" (or nowhere). Subscriptions removed before this update are restored as before.
- **Roll back:** run `supabase/rollbacks/20270105000000_stream_undo_keeps_status.down.sql`, then `supabase migration repair --status reverted 20270105000000 --linked`.

### "Make a rule" uses the bank's name
- **Migration:** `20270104000000_transactions_bank_name`. Apply it with `supabase db push --linked`, then update the dashboard. No function change.
- What changes: on a row you renamed, "Make a rule" now fills in the name the bank sends (for example "AMZN Mktp DE*123", not "Amazon"), so the rule matches that row and the next ones.
- **Roll back:** run `supabase/rollbacks/20270104000000_transactions_bank_name.down.sql`, then `supabase migration repair --status reverted 20270104000000 --linked`.

### Accounts and net worth show the same numbers
- **Migration:** `20270103000000_net_worth_numbers_agree`. Apply it with `supabase db push --linked`, then update the dashboard. No function change.
- What changes:
  - A manual account in another currency is now converted at the latest rate on the Accounts page too, as net worth already does.
  - An imported month of spending (from a spreadsheet) now stays until that month has real bank spend. Before, a single zero-share row hid it.
- With the dashboard update, the Accounts total leaves out a bank balance that is more than 30 days old, as net worth does. The account is marked "not in total".
- **Roll back:** run `supabase/rollbacks/20270103000000_net_worth_numbers_agree.down.sql`, then `supabase migration repair --status reverted 20270103000000 --linked`.

### Bank sync, prices, Splitwise and reminders hold up better
- **Migrations:** `20270101000000_holding_id_checks` and `20270102000000_splitwise_switch_account`. Apply them with `supabase db push --linked`.
- **Functions:** run `supabase functions deploy` (start-bank-consent, complete-bank-consent, sync-bank, sync-prices, notify, parse-statement and post-sync changed). Update the dashboard too, for the new bank-key message.
- What changes:
  - A failed bank-link start no longer counts toward the 5 links in progress.
  - A broken Enable Banking key now shows on the account instead of the sync going quiet.
  - A renewed bank syncs right away. That spends one more bank call than before, so a renewal late in a day the cron already used up can show a rate-limit note until the next sync.
  - Rows without a booking date use the value date.
  - The common Coinbase coins are priced.
  - Price sync reads every holding (no 1000-row cap) and asks CoinGecko in batches. New holdings must have a sensible symbol and CoinGecko id; rows already stored are not checked.
  - Connecting a different Splitwise account removes the old account's synced shares (CSV rows stay).
  - One user's failure no longer stops bank reminders for the others.
  - The Worth it? €15 line is in euros for every currency.
  - A PDF read cut short says so.
  - A category you set on money out no longer spreads to money in from the same name.
  - AI answers land on the right row when two accounts share a reference.
- **Roll back:** run `supabase/rollbacks/20270102000000_splitwise_switch_account.down.sql` and `supabase/rollbacks/20270101000000_holding_id_checks.down.sql`, then `supabase migration repair --status reverted 20270102000000 20270101000000 --linked`, and redeploy the previous functions (`git checkout <previous tag> -- supabase/functions && supabase functions deploy`).

### Notifications follow whoever is signed in on a browser
- **Migration:** `20261231000000_claim_push_subscription`. Apply it with `supabase db push --linked`, then update the dashboard. No function change.
- When a second account signed in on a browser that already had notifications on, its subscription failed silently (the endpoint was taken), so the new account got nothing and the previous one kept getting its alerts. Turning notifications on now moves this browser to the signed-in account, and signing out removes this browser's subscription.
- **Roll back:** run `supabase/rollbacks/20261231000000_claim_push_subscription.down.sql`, then `supabase migration repair --status reverted 20261231000000 --linked`, and redeploy the previous dashboard.

### The old Node sync (setup.sh, Docker, GitHub Actions, cron) is removed
- **Who:** only installs made with `./setup.sh`, `docker compose` or the `sync.yml` workflow in a fork. `npx create-alopex` installs are not affected: their sync already runs in Supabase (pg_cron + Edge Functions).
- That path counted moves between your own accounts as both spending and income, had no flow rules or transfer pairs, and GitHub stops a fork's scheduled workflow after 60 days without commits, so the sync went quiet.
- **Move over:** the installer looks for its own layout, so give it your old settings first: `mkdir -p alopex/backend && cp <your old clone>/.env alopex/backend/.env`, then run `npx create-alopex@latest` next to that `alopex` folder and keep your Supabase project when it asks. It reuses `.env` (your push keys too, so subscribed phones keep working), sets the two Vault secrets the pg_cron jobs need and deploys the functions. Coinbase: the installer does not set it up; add the Edge Function secrets `COINBASE_API_KEY_NAME`, `COINBASE_API_PRIVATE_KEY` and `COINBASE_USER_ID` (see supabase/functions/README.md). Then stop the old jobs: `docker compose down`, disable the Sync workflow in your fork, or remove the cron/launchd entries. Running both would spend your banks' ~4 daily calls twice.
- **Roll back:** check out the previous tag; nothing in the database changed.

### A ruled Transfer you change back counts as spending again
- **Function:** `post-sync` changed. Run `supabase functions deploy post-sync`. No migration.
- A row that a rule or a learned category made a Transfer stayed out of spending even after its category was changed to something else. The next sync now counts it by its direction again (spend or income), unless a flow rule still matches. Only rows from the last 90 days are re-checked.
- **Roll back:** redeploy the previous `post-sync` (`git checkout <previous tag> -- supabase/functions && supabase functions deploy post-sync`).

### Older foreign-currency Splitwise shares count in spending
- **Migration:** `20261230000000_fx_backfill_splitwise`. Apply it with `supabase db push --linked`. No function or dashboard change.
- A Splitwise share in another currency (USD, GBP, CHF and so on) from before your oldest stored exchange rate had no euro amount, so it was missing from Spending, Cash flow and Budgets. The next post-sync now fetches the past rates those shares need, as it already did for bank transactions.
- **Roll back:** run `supabase/rollbacks/20261230000000_fx_backfill_splitwise.down.sql`, then `supabase migration repair --status reverted 20261230000000 --linked`. Rates already fetched stay.

### Rejecting a transfer pair keeps a currency exchange or top-up a transfer
- **Migration:** `20261229000000_reject_pair_keeps_bank_transfer`. Apply it with `supabase db push --linked`. No function change; update the dashboard for the demo to match.
- A suggested transfer pair can have a currency exchange or wallet top-up on one side, which the bank already marks as a transfer. Rejecting the pair turned that side into spending or income for good. Now only the other side counts again; the exchange or top-up stays a transfer. Rows rejected before this update stay as they are: set such a row's category to Transfer to move it back.
- **Roll back:** run `supabase/rollbacks/20261229000000_reject_pair_keeps_bank_transfer.down.sql`, then `supabase migration repair --status reverted 20261229000000 --linked`.

### Renaming or deleting a category keeps how each row was categorized
- **Migration:** `20261228000000_category_move_keeps_source`. Apply it with `supabase db push --linked`. No function or dashboard change.
- Renaming or deleting a category marked every moved transaction as picked by hand. The next sync then copied that category onto other charges from the same merchants, and your rules stopped applying to the moved rows. A move now keeps each row as it was (AI, rule or yours). Rows moved before this update stay marked as picked by hand.
- **Roll back:** run `supabase/rollbacks/20261228000000_category_move_keeps_source.down.sql`, then `supabase migration repair --status reverted 20261228000000 --linked`.

### Rename one transaction without renaming the others
- **Migration:** `20261227000000_rename_one_or_by_price`. Apply it with `supabase db push --linked`, then redeploy the dashboard. No function change.
- Renaming a transaction now asks: all from this merchant (as before) or only this one. Only this one changes just that row, and future rows keep their name.
- Apple, PayPal and Google bill unrelated things under one bank name (iCloud and Apple Music are both "Apple.com"). Renaming one of those now renames only charges of about the same price (within 10%), past and future, so two Apple subscriptions keep two names. A name you gave one of them before this update stays on all of them until you rename each one.
- **Roll back:** run `supabase/rollbacks/20261227000000_rename_one_or_by_price.down.sql`, then `supabase migration repair --status reverted 20261227000000 --linked`. Names set per price are lost; names already on transactions stay.

### Imported spending counts on Cash flow and Reports
- **Migration:** `20261226000000_income_expenses_spend_history`. Apply it with `supabase db push --linked`, then update the dashboard (without it, Cash flow's diagram over imported months has more spending by category than in total).
- Past monthly spending you imported by CSV showed on Spending and Budgets but not on Cash flow, Reports (income minus spending), Income or the Transactions in/out totals, which showed no spending for those months. Those totals now count it the same way Spending does: only for a month with no bank spending. Imported months have no income, so they show as months where you spent more than you earned.
- **Roll back:** run `supabase/rollbacks/20261226000000_income_expenses_spend_history.down.sql`, then `supabase migration repair --status reverted 20261226000000 --linked`.

### One bad holding no longer stops prices for everyone
- **Migration:** `20261225000000_holding_quantity_checks`. Apply it with `supabase db push --linked`, then `supabase functions deploy sync-prices`.
- A holding whose quantity was not a real number (NaN, infinite or too big to value, which only a hand-made API call could save) made the daily price sync fail for every user. The sync now skips such a holding, and new holdings must have a finite quantity of zero or more. Holdings already stored are not checked or changed; one with such a quantity gets no new price until you fix or delete it.
- **Roll back:** run `supabase/rollbacks/20261225000000_holding_quantity_checks.down.sql`, then `supabase migration repair --status reverted 20261225000000 --linked`.

### Banks sync in waking hours
- **Migration:** `20261224000000_bank_sync_hours`. Apply it with `supabase db push --linked`. No function or dashboard change.
- Still 4 bank syncs a day (banks allow about 4 unattended reads a day per account), now at 05:17, 11:17, 16:17 and 21:17 UTC (06/12/17/22 CET, 07/13/18/23 CEST) instead of every 6 hours from midnight UTC, so no run is spent at night. Post-sync, prices, Splitwise and subscriptions follow each run as before.
- **Roll back:** run `supabase/rollbacks/20261224000000_bank_sync_hours.down.sql`, then `supabase migration repair --status reverted 20261224000000 --linked`.

### Subscriptions follow your transaction edits
- **Migrations:** `20261222000000_recurring_streams_gone` and `20261223000000_transaction_type_source`. Apply them with `supabase db push --linked`, then `supabase functions deploy` (new function `refresh-recurring`; `detect-recurring` changed), then redeploy the dashboard.
- A transaction type you pick yourself (Subscription or One-time) is now remembered: the sync, rules and the AI no longer change it, and charges you mark One-time never make a subscription, even when they come every month. Types picked before this update aren't marked: pick One-time again on those charges.
- Renaming a transaction, marking it One-time, recategorizing or deleting it now shows on the Subscriptions page as soon as you open it, instead of after the next 6-hour run.
- A subscription you confirmed or archived that is no longer found (say its charges are now One-time) is hidden instead of staying forever. It keeps your choices and comes back if it is found again. A confirmed one-off charge (no regular rhythm) stays listed however old it gets, as before (under Stopped once you set its frequency).
- Known limit: PayPal, Apple and Google subscriptions are told apart by their lowest charge. Deleting or recategorizing that cheapest charge hides the confirmed row and lists the stream again under To review.
- The Subscriptions re-check runs at most once every 5 seconds per user (a quicker repeat keeps the saved list). A new server-only table `recurring_detection_runs` records when detection last ran; the rollback drops it.
- **Roll back:** first redeploy the previous dashboard (this one reads and writes the new column) and the previous Edge Functions (`supabase functions deploy` from the previous release; this `detect-recurring` reads the new column, so the 6-hourly run fails for every user without it, and delete the new `refresh-recurring` with `supabase functions delete refresh-recurring`), then run `supabase/rollbacks/20261223000000_transaction_type_source.down.sql`, then `supabase/rollbacks/20261222000000_recurring_streams_gone.down.sql`, and `supabase migration repair --status reverted 20261223000000 20261222000000 --linked`.

### Category icons, colours and safe delete
- **Migration:** `20261221000000_category_look_and_move`. Apply it with `supabase db push --linked`, then redeploy the dashboard.
- Your categories can have an icon and a colour (Settings › Categories), built-in ones too.
- Deleting a category asks where its transactions go and moves them there, with its rules, subscriptions, Splitwise shares, budgets and imported spend history, so nothing is left on a category that no longer exists. Renaming works the same way.
- **Roll back:** run `supabase/rollbacks/20261221000000_category_look_and_move.down.sql` and `supabase migration repair --status reverted 20261221000000 --linked`; your categories show their first letter again.

### Trade Republic bank rows matched to your CSV
Trade Republic over Enable Banking sends only a date and an amount, so buys counted as spending and deposits as income. Import your Trade Republic CSV (Investing -> Import) and each bank row is matched to the CSV row it came from: buys, sells, deposits and withdrawals become transfers ("Buy World ETF"), dividends, interest and Saveback income, taxes go to Taxes. What you set by hand stays; undoing the import puts the rows back. Rows with no single match stay as they were.
- **Migration:** `20261220000000_broker_matching`. Apply it with `supabase db push --linked`, then `supabase functions deploy post-sync`.
- **Rollback:** `supabase/rollbacks/20261220000000_broker_matching.down.sql` (matched rows keep their flow and category, names go).

## v0.4.1 (21 Nov 2026)

Fixes from a fresh install end to end: the installer works on a brand-new Supabase account, a new bank is sorted minutes after linking, older foreign-currency rows get their euro amount, and Trade Republic and Splitwise imports work on a fresh install.

**Upgrade with the installer:** run `npx create-alopex@latest` from the same place as the first time, or inside the install folder. It keeps `backend/.env`, applies the new migrations, deploys the Edge Functions and redeploys the dashboard, in that order.

### Fresh-install fixes (e2e test, 20 Nov 2026)
- **Migration:** `20261217000000_queue_edge_job`. Apply it with `supabase db push --linked`, then `supabase functions deploy` (`post-sync`, `complete-bank-consent` and `reapply-rules` changed).
- Right after you connect a bank, categories, transfers and then subscriptions are worked out at once, in rounds, instead of at the next 6-hour run.
- Transactions in another currency from before your install now get their euro amount: post-sync fetches the past exchange rates they need (Frankfurter, the source the price sync already uses).
- Rules: "Apply to past transactions" now also files transactions that had no category yet.
- **Roll back:** run `supabase/rollbacks/20261217000000_queue_edge_job.down.sql` and `supabase migration repair --status reverted 20261217000000 --linked`.

### Splitwise sync needs Splitwise Pro
- **Migration:** `20261216000000_splitwise_pro_required`. Apply it with `supabase db push --linked`, then `supabase functions deploy` (`splitwise-connect` and `sync-splitwise` changed), then redeploy the dashboard.
- Since 2026 Splitwise serves API keys only while the account that registered the app has an active Splitwise Pro subscription. Each Alopex user registers their own key, so each user who wants the automatic sync needs Splitwise Pro. The CSV import works for everyone, without Pro.
- When Splitwise says the key's account has no Pro, connecting says so, and a sync marks the connection `pro_required` (new status; the cron skips it until you connect again, as for a refused key). A key that worked and is now refused may mean the Pro subscription ended: the message says so.
- **Roll back:** run `supabase/rollbacks/20261216000000_splitwise_pro_required.down.sql` and `supabase migration repair --status reverted 20261216000000 --linked`; `pro_required` connections become `needs_reconnect`.

## v0.4.0 (19 Nov 2026)

Splitwise syncs by itself, "Is this Anna?" on incoming paybacks, complete Trade Republic imports (dividends, fees, taxes, cash) and Ledger Live, and banks that keep a longer history and say why a sync stopped.

**Upgrade with the installer:** run `npx create-alopex@0.4.0` from the same place as the first time, or inside the install folder. It keeps `backend/.env`, applies the new migrations, deploys the Edge Functions and redeploys the dashboard, in that order.

**Upgrade by hand**, in this order:
1. Backend: `git pull`, then `supabase db push --linked` (4 migrations, 20261212000000 to 20261215000000).
2. `supabase functions deploy` (new functions `splitwise-connect` and `sync-splitwise`; `sync-bank`, `start-bank-consent` and shared code changed).
3. Dashboard: `git pull` and redeploy. The new dashboard needs steps 1 and 2 first.
4. Docker or launchd sync only: rebuild or restart it (`sync-networth.js` now handles revoked or closed bank consents).

No new secrets. Each change below says what it needs and how to roll it back.


### Investment events, and more detail on trades (Trade Republic complete)
- **Migration:** `20261215000000_investment_events`. Apply it with `supabase db push --linked` BEFORE redeploying the dashboard: the new dashboard reads and writes `investment_events` and the new `holding_trades` columns, and an older database answers with an error. No Edge Function changes.
- New table `investment_events`, owner-only: dividends, interest, rewards, fees, taxes, deposits, withdrawals, transfers in and out, and corporate actions, from any broker. A re-import skips what's saved (unique per user, source and the broker's id).
- `holding_trades` gets optional columns: `tax_eur`, `traded_at`, `note`, `currency` + `price_native`, `group_id`. Existing rows are unchanged.
- `delete_holding` also deletes the holding's events.
- Trade Republic: trades imported before this release are skipped on re-import, so they stay without tax. To get the tax, delete the holding's Trade Republic trades and import the file again.
- **Roll back:** revert the dashboard first, then run `supabase/rollbacks/20261215000000_investment_events.down.sql` and `supabase migration repair --status reverted 20261215000000 --linked`. Imported events are lost, and so are the trades' tax, time, note, native price and group (tax becomes 0). Importing the broker files again brings the events back, but not the trade detail: already-saved trades are skipped. To get it back, delete those trades and import again.
### Who owes you: "Is this Anna?" on incoming payments
- **Migration:** `20261214000000_payback_matching`. Apply it with `supabase db push --linked` BEFORE redeploying the dashboard. On an older database the new dashboard breaks two things: the payment suggestions on Who owes you do not load, and ticking a split bill as settled fails (the dashboard now also clears the new `settled_by_*` columns). No Edge Function changes.
- New on `transactions`: `payback_contact` (on an incoming payment, who paid you back; empty = "not a payback"), `settled_by_account` / `settled_by_ref` (on a split bill, the payment that settled it). New table `payer_links` (a payer name, as the bank writes it, linked to a contact; names only, never IBANs) with row level security. New functions `payback_candidates`, `record_payback`, `undo_payback`, `payback_eligible`, `payer_key`, `payer_name_of`. Existing rows are not changed.
- Only plain incoming money is suggested: not transfers, Splitwise settle-ups, split refunds, refunds or money from your own accounts. Confirming a payment turns it into a transfer (so it stops counting as income) and settles that person's own open split bills, oldest first, while the payment covers them whole; split refunds owed to them count against those bills and close with them. Bills shared with others are left to settle by hand. Splitwise balances are not touched: record the payment in Splitwise too.
- **Roll back:** redeploy the previous dashboard first, then run `supabase/rollbacks/20261214000000_payback_matching.down.sql`, then `supabase migration repair --status reverted 20261214000000 --linked`. Bills already settled stay settled and confirmed payments stay transfers, but the rollback deletes what cannot be kept without the new columns: which payment settled which bill (Undo is no longer possible), every "not a payback" answer (those payments would be asked about again after a re-apply) and all payer links.
### Splitwise syncs by itself (API key)
- **Migration:** `20261213000000_splitwise_api_sync`. Apply it with `supabase db push --linked` BEFORE deploying the Edge Functions and the dashboard, then `supabase functions deploy` (new functions `splitwise-connect` and `sync-splitwise`). It needs Supabase Vault (every Supabase project has it) and, for the schedule, the Vault secrets `project_url` and `sync_bank_secret_key` from `20261117000000_sync_all_banks`.
- Each user can paste their own Splitwise API key (from an app they register at https://secure.splitwise.com/apps). The key is kept in Supabase Vault, never in a table column, and only the `sync-splitwise` function reads it. Every 6 hours (cron job `sync-splitwise`, 42 minutes past, UTC) and on "Sync now", your shares of expenses someone else paid come in by themselves; expenses you paid and settle-ups wait on a review list to be linked to the bank payment, counted, or dismissed. Edits and deletions in Splitwise follow; a category or description you set stays.
- Shares you already imported from a CSV file are recognised (same date within a day, description, amount and currency) and kept, not doubled. Re-importing a CSV no longer deletes rows the sync wrote, and a CSV imported after connecting skips the shares the sync already brought in. Undoing a CSV import leaves the rows the sync adopted from it (and their bank links). Corrections from a CSV file never remove or rewrite a synced share, nor add it again.
- `splitwise_balances` now keeps one row per currency (its primary key gains `currency`) and takes `basis = 'api'`; while connected, a CSV import leaves a group's API balances as they are.
- Disconnecting deletes the key; "delete data" also removes the expenses the sync added and frees the bank payments it changed; your CSV imports stay, with their categories, bank links and transfers. Deleting your account deletes the connection and its key.
- **Roll back:** revert the dashboard and the Edge Functions first, then run `supabase/rollbacks/20261213000000_splitwise_api_sync.down.sql` and `supabase migration repair --status reverted 20261213000000 --linked`. Keys are deleted from Vault; shares already synced stay as ordinary Splitwise shares; balances from the API are deleted (import the group's file again). The To link list goes: links made there for an expense you paid all for others, one with several payers, or a settle-up are undone (those bank payments count as they did before linking), and expenses you ignored are forgotten. If you apply the migration again, those expenses wait on To link again: link or ignore them once more.
### Enable Banking: longer history, ended consents, clearer sync errors
- **Migration:** `20261212000000_bank_sync_health`. Apply it with `supabase db push --linked`, THEN redeploy the Edge Functions (`supabase functions deploy`): the new `sync-bank` and `complete-bank-consent` read the new columns. Then redeploy the dashboard.
- Sync changes below apply to the Edge sync (Supabase cron) only, except the revoked/closed consent handling, which `sync-networth.js` (Docker/launchd) gets too.
- A newly linked bank's first sync asks Enable Banking for the longest history the bank keeps (`strategy=longest`), often a year or more, instead of 90 days. A sync whose cursor is older than what the bank keeps no longer fails forever (`WRONG_TRANSACTIONS_PERIOD`): it reads from as far back as it can. Pages read before a failure are saved.
- A consent the user revoked or the bank closed (`REVOKED_SESSION`, `CLOSED_SESSION`) shows the Renew banner and push, like an expired one (Edge sync and the Docker/launchd `sync-networth.js`). The cron no longer calls accounts whose consent has ended.
- New links ask for the bank's own maximum consent length when it is under 180 days. Renewing a bank closes the old Enable Banking session.
- Each account remembers why its last sync failed (`accounts.sync_error`, cleared by the next good run or a renewal); the dashboard says it in plain words. `sync-bank` answers 429 when the bank's daily limit for automatic updates is reached.
- **Roll back:** revert the dashboard and the Edge Functions first, then run `supabase/rollbacks/20261212000000_bank_sync_health.down.sql` and `supabase migration repair --status reverted 20261212000000 --linked`. After a rollback and a later re-apply, every account's `bank_session_id` is empty, so the next renewal of each bank cannot close its old session; Enable Banking ends it when its consent runs out.

## v0.3.0 (14 Nov 2026)

Notes and tags, a Cash flow page, a recurring calendar with regular income, who paid you on income, and a round of fixes (dark-mode toasts, Back closes dialogs, a safer installer).

**Upgrade with the installer:** run `npx create-alopex@0.3.0` from the same place as the first time, or inside the install folder. It keeps `backend/.env`, applies the new migrations, deploys the Edge Functions and redeploys the dashboard, in that order.

**Upgrade by hand**, in this order:
1. Backend: `git pull`, then `supabase db push --linked` (4 migrations, 20261208120000 to 20261211000000). Do this BEFORE the dashboard: the new dashboard reads the new columns and its Transactions, Income and Cash flow pages fail on an older database.
2. No Edge Function changes in this release.
3. Dashboard: `git pull` and redeploy.
4. Docker or launchd sync only: nothing changed, no restart needed.

### Installer: `--help`, safer arguments and updating from inside the install (#132)
- No migration, no dashboard change. `npx create-alopex --help` prints usage; an unknown option (`--yes`) or two folder names stops with an error before anything is downloaded. A folder name starting with `-` goes after `--`; a folder containing `%` is refused (Windows would expand it).
- Run with no folder from inside an install (or its `backend/` or `dashboard/`), it asks to update that install instead of creating a new one inside it.

### Dashboard fixes
- No migration. Toasts follow dark mode and the app's font; browser or phone Back closes an open dialog instead of leaving the page, and focus returns to what opened it; "1 row" instead of "1 rows"; the demo says up front that bank connection is off; scrubbing Net Worth to a day before your first breakdown says so instead of showing another day's mix.


### Old rules with long text can be changed again (#141)
- **Migration:** `20261211000000_rule_text_length_on_change`. Apply it with `supabase db push --linked` after `20261210000000_income_kind_rules`. No dashboard or Edge Function changes.
- Rules saved before the 200-character cap on rule text refused every change, even marking income regular or re-sorting. The cap now applies only to new or changed text, with the same limit and error.
- **Roll back:** run `supabase/rollbacks/20261211000000_rule_text_length_on_change.down.sql` and `supabase migration repair --status reverted 20261211000000 --linked`.

### Recurring calendar and regular income
- **Migration:** `20261210000000_income_kind_rules`. Apply it with `supabase db push --linked` BEFORE redeploying the dashboard (the dashboard reads and writes the new column). No Edge Function changes.
- Subscriptions has a Calendar view: the month's expected charges from your recurring streams, ticked once paid, and the income you get regularly.
- Income splits Regular and One-off. A sender that paid you in at least 3 of the last 6 months counts as regular, whatever the amount. "Mark as regular" or "Mark as one-off" on a row saves a rule (`category_rules.set_income_kind`) that overrides the guess for that name.
- **Roll back:** revert the dashboard first (it reads the new column on every rules load), then run `supabase/rollbacks/20261210000000_income_kind_rules.down.sql` and `supabase migration repair --status reverted 20261210000000 --linked` (so a later `db push` re-applies it). The down file deletes rules that only marked income; rules that also set a category, type or flow keep those and lose only the mark.

### Income shows who paid you
- **Migration:** `20261209000000_transactions_payer_name`. Apply it with `supabase db push --linked` after `20261208120000_transaction_notes_tags` and BEFORE redeploying the dashboard: the new dashboard asks `v_transactions_eur` for `payer_name`, and an older database answers with an error, so the Income and Cash flow pages would not load.
- `v_transactions_eur` gets one new column at the end, `payer_name`: the name you gave the row, or else who paid you (the bank's debtor name). On an incoming payment the old "creditor" name is often your own name or empty, so Income and Cash flow now name the payer instead. Nothing else in the view changes and no rows are touched.
- **Roll back:** redeploy the previous dashboard, then `supabase migration repair --status reverted 20261209000000 --linked`. The column can stay: an older dashboard never reads it (see `supabase/rollbacks/20261209000000_transactions_payer_name.down.sql`).

### Notes and tags on transactions
- **Migration:** `20261208120000_transaction_notes_tags`. Apply it with `supabase db push --linked` BEFORE redeploying the dashboard: the new dashboard reads the new columns, and its Transactions page can't load without them. No Edge Function or sync change.
- Each transaction can have a note (free text, up to 2000 characters) and tags (up to 20, each up to 40 characters, created as you type). The Transactions page filters by tag and its search also matches notes. Both are in the data export.
- The bank sync never writes them, so a sync re-run keeps them. Only your own rows can be changed (same rule as categories).
- **Needs a UTF8 database** (every Supabase project is). On a plain Postgres created with another encoding (initdb's default can be SQL_ASCII), saving tags fails with `Unicode normalization can only be performed if server encoding is UTF8`. Check with `show server_encoding;`.
- **Roll back:** revert the dashboard first (this release's dashboard calls `my_transaction_tags`, which the rollback drops), then `supabase/rollbacks/20261208120000_transaction_notes_tags.down.sql`. It drops tag suggestions and the limits; the note and tags columns stay, with what you wrote, and an older dashboard ignores them. Pushing the migration again later works: it tidies anything written in between (blank notes, extra spaces, repeated tags).

## v0.2.0 (11 Nov 2026)

Budgets, two-step sign-in, rules that match whole words, debts, transfers that stop counting as spending, safer imports and refunds.

**Upgrade with the installer:** run `npx create-alopex@0.2.0` from the same place as the first time, or inside the install folder. It keeps `backend/.env`, applies the new migrations, deploys the Edge Functions and redeploys the dashboard, in that order.

**Upgrade by hand**, in this order:
1. Backend: `git pull`, then `supabase db push --linked` (13 migrations, 20261124 to 20261207).
2. `supabase functions deploy` (new function `reapply-rules`; `post-sync`, `sync-bank` and others changed).
3. Dashboard: `git pull` and redeploy. One exception: deploy the dashboard before or together with step 1 if you import statements, see "Manual rows and imports get input limits".
4. Docker or launchd sync only: rebuild or restart it.

If you use your own PostgREST pre-request hook, read "Two-step sign-in" before step 1. Each change below says what it needs and how to roll it back.

### Deleting a rule can re-sort the transactions it filed
- No migration. Run `supabase functions deploy reapply-rules` BEFORE redeploying the dashboard (an older function ignores the new request and would preview your current rules instead).
- After you delete a rule on the Rules page, it offers to re-sort the transactions that rule had filed and no other rule matches (for example "Barclays" filed as Dine Out by an old "bar" rule). They go back to uncategorized and the next sync sorts them again. Categories you set by hand and Transfer rows never change. If the rule also set a transaction type, that type stays on those rows.

### Manual rows and imports get input limits
- **Migration:** `20261207000000_manual_transaction_checks`. Redeploy the **dashboard first** (or at the same time), then apply it with `supabase db push --linked`. An older dashboard sends descriptions longer than 500 characters, which the new database refuses: an import would stop at that row on every retry.
- Rows added by hand or by a statement import (`add_manual_transaction`) now have limits: amounts up to a trillion, a 3-letter currency, descriptions up to 500 characters, categories up to 100, a debit or credit direction, and up to 60 characters for the name of a new manual account (accounts named before keep working).
- Rows sent in parallel by an import no longer create the same manual account twice.
- Only the function changes; existing rows are untouched.
- **Roll back:** `supabase/rollbacks/20261207000000_manual_transaction_checks.down.sql` (restores the previous function).
### Rules match whole words and apply to past transactions from the dashboard
- **Migration:** `20261206000000_rule_match_mode`. You apply it with `supabase db push --linked` BEFORE redeploying the Edge Functions and the Docker/launchd sync (they read the new column), then `supabase functions deploy` (new function `reapply-rules`) and redeploy the dashboard.
- A rule now says how its text must appear (`category_rules.match_mode`): `word` (on its own, so "bar" no longer matches "Barclays"), `exact` (the whole field) or `contains` (anywhere). Rules made before keep `contains`, so nothing changes for them; new rules from the dashboard default to `word`.
- The Rules page has "Apply to past transactions": it shows how many transactions would change first, and never touches categories you set by hand or anything into or out of Transfer. The CLI `node categorize.js --reapply-rules` still works.
- A rule whose text is only spaces no longer matches anything. Before, an "Anywhere" rule like that caught almost every transaction. The dashboard never allowed one, so this only matters if you added it with SQL.
- Rule text is now limited to 200 characters for new and edited rules. Longer (or empty) rules you already have keep working, but they can't be edited, and if you delete one there's no Undo: add it again shorter.
- **Roll back:** `supabase/rollbacks/20261206000000_rule_match_mode.down.sql` (every rule goes back to matching anywhere). Revert the Edge Functions and the sync too: they read `match_mode`.

### Refund links can't be changed by hand
- **Migration:** `20261205000000_lock_refund_of`. Apply it with `supabase db push --linked`, then `supabase functions deploy post-sync` (same release: refund pairing now skips rows you or a rule decided, and repairs half-applied pairs). No dashboard change, so the order doesn't matter.
- `refund_of` (which charge a refund reverses) is now set only by the refund pairing after each sync; a signed-in user changing it through the API gets "Bank-provided fields on transactions cannot be changed". Existing links are untouched.
- **Roll back:** `supabase/rollbacks/20261205000000_lock_refund_of.down.sql` (users can change `refund_of` again).

### Two-step sign-in
- **Migration:** `20261203000000_require_mfa`. Apply it with `supabase db push --linked` BEFORE redeploying the Edge Functions (they call `mfa_satisfied`), then redeploy the dashboard.
- It sets PostgREST's pre-request hook (`pgrst.db_pre_request`) to `public.require_mfa`. If you already use your own hook, the migration stops with an error: call `public.require_mfa()` from your hook, clear it with `alter role authenticator reset pgrst.db_pre_request;` and `alter role authenticator in database postgres reset pgrst.db_pre_request;` (it may be set either way), push again, then set yours back the way it was. The check only sees a hook set on the database role: if yours is in PostgREST's own config (`db-pre-request` in its config file or `PGRST_DB_PRE_REQUEST`, on a self-run stack), move it into the database and chain it as above before pushing, or one of the two hooks may stop running.
- Settings has **Two-step sign-in**: scan a QR code with an authenticator app (1Password, Google Authenticator, Aegis, ...) and type its 6-digit code. From then on, sign-in asks for a code. The database enforces it: a session that skipped the code gets 403 on every API call (tables, views and functions), and the Edge Functions refuse it. Users without an authenticator are not affected.
- **Guessing codes:** Supabase allows about 15 code checks a minute per IP address and the dashboard stops at that limit. For stricter limits (lock an account after N wrong codes), add Supabase Auth's MFA verification attempt hook.
- **Changing the password in Settings** checks the current one without starting a new session (a new one would drop the code step). If you turned on Supabase Auth's "Secure password change" (off by default), a session older than 24 hours can't change the password: the dashboard says to sign out and sign in again.
- **Lost your phone?** There are no backup codes: add a second authenticator in Settings while you still have the first. If every authenticator is gone, the instance owner removes them in the Supabase SQL editor: `delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'you@example.com');`, then sets it up again.
- **Roll back:** `supabase/rollbacks/20261203000000_require_mfa.down.sql` (after reverting the Edge Functions). If you chained your own hook, remove its `require_mfa()` call first: the rollback stops while a hook still calls it, and it leaves your hook in place. Run it in the SQL editor or with `psql -v ON_ERROR_STOP=1 -1 -f <file>`, so a refusal stops it.

### Monthly budgets per category
- **Migration:** `20261202100000_category_budgets`. You apply it with `supabase db push --linked`, then redeploy the dashboard. No Edge Function or sync change.
- Adds `category_budgets`: a budget per category that holds from its month onward until you change it, with optional rollover (a month's leftover or overspend moves into the next). Only spend counts, never transfers or income. Budgets are in the export.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261202100000_category_budgets.down.sql` (budgets are lost; export your data before if you want to keep them). A dashboard of this release without the table cannot open Budgets, and its data export fails.

### Broker imports skip trades already imported
- **Migration:** `20261201000000_holding_trades_external_id`. Apply it with `supabase db push --linked` BEFORE redeploying the dashboard: its broker import writes the new columns.
- Each trade can remember the broker it came from and the broker's own id for it (`holding_trades.source`, `holding_trades.external_id`, both optional). Re-importing the same broker file skips trades already there by id, and two identical buys on the same day stay two trades. Trades typed in or imported before keep both empty.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261201000000_holding_trades_external_id.down.sql` (the stored broker ids are lost; the trades stay).

### Credit cards and loans count as debt
- **Migration:** `20261130000000_account_types`. You apply it with `supabase db push --linked` BEFORE redeploying the Edge Functions and the Docker/launchd sync (they read and write the new column), then redeploy the dashboard.
- Every account gets a type (`accounts.account_type`): checking, savings, credit card, loan, investment or other. New links take it from the bank; accounts linked before get it on their next sync (one extra bank call per account, once). Empty means unknown and counts as checking (a bank that sends no type gets checking). You can correct it in the dashboard.
- Credit cards and loans subtract from net worth, whatever sign the bank gives their balance. `v_net_worth_daily` has a new last column, `liabilities_eur` (positive); `bank_total_eur` leaves debts out and `total_eur` subtracts them.
- You can add a debt by hand (a manual loan account with a balance you update, removable once paid). Its balance keeps counting until you change it, without the 30-day limit of bank balances, at each day's exchange rate.
- CDs no longer count in net worth; data stays in the export until a later release drops the table.
- **Roll back:** `supabase/rollbacks/20261130000000_account_types.down.sql` (debt balances typed in by hand are deleted; account types are lost). The Edge Functions of this release read `account_type`: revert them too (the Node sync works either way).

### Rules can only set how a row counts
- **Migration:** `20261129000000_flow_only_rules`. Apply it with `supabase db push --linked` BEFORE redeploying the dashboard: "It's a transfer" in the To review list saves a rule that sets only the flow.
- The `at_least_one_action` check on `category_rules` now also accepts a rule that sets only `set_flow_type`, and is added on databases that didn't have it.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261129000000_flow_only_rules.down.sql` (it deletes rules that set only the flow).

### Transfers between your own accounts stop counting as spend and income
- **Migration:** `20261128000000_transfer_detection`. You apply it with `supabase db push --linked` BEFORE redeploying the Edge Functions and the Docker/launchd sync (they write the new columns), then redeploy the dashboard.
- Every transaction now remembers who decided whether it is spend, income or a transfer (`flow_source`). Every flow set before this release is marked `legacy`: it never changes by itself, and the dashboard can list the ones that look wrong for you to review.
- The sync notes whether the other side of a payment is one of your own accounts (only yes or no is stored, never the IBAN), and such payments become transfers.
- After each sync, a debit on one of your accounts and the same amount credited on another within 4 days are paired as a suggested transfer. The dashboard lets you confirm it or say it is not a transfer; a rejected pair is never proposed again.
- A rule can now say how matching rows count (`category_rules.set_flow_type`).
- **Roll back:** `supabase/rollbacks/20261128000000_transfer_detection.down.sql` (flows already set stay; who set them and the pairs are dropped). The Node sync of this release writes `flow_source`: revert it too.

### Sync cursors follow their account; bank links keep the server's clock
- **Migration:** `20261127000000_cursor_fk_and_consent_clock`. You apply it with `supabase db push --linked`, then redeploy the Edge Functions and the dashboard.
- A deleted account no longer leaves its sync cursor behind; cursors of accounts already deleted are removed.
- A pending bank link always takes the database's time, so its 15-minute window can't be stretched.
- The bank's one-time code now reaches the dashboard in the URL fragment (`#bank_code=`), which browsers never send to the dashboard's host or its logs.
- **Roll back:** `supabase/rollbacks/20261127000000_cursor_fk_and_consent_clock.down.sql` (deleted orphan cursors are not restored).

### Bank payloads no longer keep other people's IBANs
- **Migration:** `20261126000000_raw_without_accounts`. You apply it with `supabase db push --linked`, then redeploy the Edge Functions.
- `transactions.raw` (the bank's payload, kept for support and export) stored the counterparty's account number on transfers. The sync now leaves it out, and the migration removes it from stored rows. Nothing in the app used it; every other field stays.
- **Not reversible:** the removed numbers can't be restored. Want them? Download the export (Settings → Your data) before you apply it.

### Delete your account from Settings
- **Migration:** `20261125000000_account_deletion`. You apply it with `supabase db push --linked`, then redeploy the Edge Functions and the dashboard.
- Deleting a user used to fail: most tables pointed at the user with no delete rule. They now cascade, so deleting a user (Settings → Delete account, or Supabase Auth → Users) removes all their rows, including investments and coins, and deleting an account removes its transactions.
- The instance owner (the first user) can't delete themselves from Settings while other users exist: the next user would silently become owner.
- Settings asks for your password again before deleting (checked by the server).
- New server-only table `bank_sessions` remembers each Enable Banking session, so deleting your account also closes it at the bank. Links made before this release are not in it; their consent simply expires.
- **Roll back:** `supabase/rollbacks/20261125000000_account_deletion.down.sql`.

### Bank links finish in the signed-in dashboard
- **Migration:** `20261124000000_sync_all_banks_skip_manual` (manual accounts are no longer sent to the bank sync). Redeploy the Edge Functions and the dashboard together (run the installer again, or `supabase functions deploy` + redeploy the dashboard). A new backend with an old dashboard leaves new bank links unfinished until the dashboard is updated.
- The bank's redirect used to store the accounts under whoever *started* the link, so on an instance with several users, one could send another their own consent URL and receive that person's accounts. `bank-consent-callback` now only forwards the browser; the new `complete-bank-consent` links the accounts for the signed-in user, and only if that user started the link.
- Your Enable Banking redirect URL does not change.
- A newly linked account starts its first sync right away (balance and transactions) instead of waiting up to 6 hours for the cron. It uses the same secret key as the cron, so nothing to configure.
- An old dashboard shows "Couldn't link the bank" for new links until you redeploy it.
- **Roll back:** `supabase/rollbacks/20261124000000_sync_all_banks_skip_manual.down.sql`.

## v0.1.0 and earlier

### Splitwise balances say who owes whom
- **Migration:** `20261123000000_splitwise_balances_basis`. Apply it with `supabase db push --linked`, then redeploy the dashboard.
- Each stored Splitwise balance says what it means: `group` (a member's net toward the whole group, how balances were stored before) or `pairwise` (what you owe that member), which the dashboard now writes. Rows saved before, or by an older dashboard, stay `group` and are never read as per-person debts.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261123000000_splitwise_balances_basis.down.sql`.

### Subscriptions radar: merchant keys and recurring streams
- **Migrations:** `20261119000000_merchant_key`, `20261119000001_aliases_by_merchant_key`, `20261119000002_alias_exact_first`, `20261120000000_recurring_streams`, `20261120000001_schedule_detect_recurring`, `20261121000000_recurring_streams_v2`, `20261122000000_recurring_streams_variant_dismissal`. Apply them with `supabase db push --linked` BEFORE redeploying the Edge Functions (`supabase functions deploy`: the bank sync writes `merchant_key`, and `detect-recurring` is new), then redeploy the dashboard. `20261120000001` needs the pg_cron setup of `20261118000000_schedule_sync` below.
- Each transaction and alias gets a normalized merchant name (`merchant_key`, written by the sync only), so "LIDL 4521" and "LIDL 4521 MILANO IT" group together and share one rename. An alias for an exact name still wins over one for the key.
- Recurring charges are detected every 6 hours into `recurring_streams` (the Subscriptions page). Your old subscription choices carry over; a name you dismissed no longer hides charges of another name you kept.
- **Roll back:** newest first, after reverting the dashboard, the detector and the sync: `20261122000000`, `20261121000000`, `20261120000001`, `20261120000000`, `20261119000002`, `20261119000001`, then `20261119000000` (each `supabase/rollbacks/<name>.down.sql`). Streams and merchant keys are lost; the transactions stay.

### The sync runs inside Supabase (pg_cron)
- **Migrations:** `20261117000000_sync_all_banks` and `20261118000000_schedule_sync`. First set the two Vault secrets `project_url` and `sync_bank_secret_key` (see the top of `20261117000000_sync_all_banks.sql`; `npx create-alopex` sets them), deploy the Edge Functions (`supabase functions deploy`), then `supabase db push --linked`.
- **Stop your other scheduler at the same time** (launchd, the Docker `scheduler.js`, or the GitHub Actions `sync.yml`): two schedulers double the bank calls, and banks allow about 4 unattended calls a day per account.
- pg_cron then syncs every bank account every 6 hours, followed by post-sync, prices and notifications (times in UTC). A job only queues its request: look for failures in `net._http_response` (query at the top of `20261118000000_schedule_sync.sql`).
- **Roll back:** `supabase/rollbacks/20261118000000_schedule_sync.down.sql` (stops the schedule; restart your old scheduler, or nothing syncs), then `supabase/rollbacks/20261117000000_sync_all_banks.down.sql`.

### Splitwise undo keeps how a row counts
- **Migration:** `20261116000000_splitwise_undo_keeps_flow`. You apply it with `supabase db push --linked`.
- Undoing a Splitwise import no longer resets spend/income on bank rows it only gave a share; only rows the import marked as transfers are reset.
- **Roll back:** `supabase/rollbacks/20261116000000_splitwise_undo_keeps_flow.down.sql`.

### Your own categories
- **Migration:** `20261115000000_user_categories`. You apply it with `supabase db push --linked`. Until then everyone has the built-in categories, as before.
- Adds `user_categories`: add categories of your own or hide built-in ones you don't use (Settings → Categories in the dashboard). The AI categorizes with your list. Transfer and Income can't be hidden.
- **Roll back:** `supabase/rollbacks/20261115000000_user_categories.down.sql`. Transactions keep the category names they have.

### Net worth keeps a bank that didn't sync, and counts deposits
- **Migration:** `20261114000000_net_worth_bank_carry_and_deposits`. You apply it with `supabase db push --linked`. No dashboard change needed.
- A bank whose sync failed on a day (an expired consent, say) dropped out of that day's net worth. Each account now keeps its last balance for up to 30 days.
- Deposits (CDs) now count in net worth, inside cash, from their start until they mature.
- **Roll back:** `supabase/rollbacks/20261114000000_net_worth_bank_carry_and_deposits.down.sql`.

### Spending and subscription view fixes
- **Migration:** `20261113000000_spend_and_subscription_views`. You apply it with `supabase db push --linked`. No dashboard change needed.
- Spending: a month with imported totals and Splitwise shares listed each category twice; now once, with the same total.
- Subscriptions: a shared plan counted at full price; it now counts your share when one is set.
- **Roll back:** `supabase/rollbacks/20261113000000_spend_and_subscription_views.down.sql`.

### Selling or changing a holding moves net worth at once
- **Migration:** `20261112000000_set_holding_quantity`. You apply it with `supabase db push --linked`. Until then the dashboard changes the quantity as before, and net worth follows at the next price sync.
- Adds `set_holding_quantity`: changing a quantity (or Mark as sold) also writes today's value from the latest price. Before, net worth kept the old value until the price sync ran, and for good where it doesn't.
- **Roll back:** `supabase/rollbacks/20261112000000_set_holding_quantity.down.sql`.
### Import a statement PDF
- **Deploy the function and set its key:** `supabase functions deploy parse-statement`, then `supabase secrets set GEMINI_API_KEY=<the key in your .env>`. No migration.
- The dashboard's statement import also takes PDFs: Gemini reads the transactions, you check them and confirm. The PDF is sent to Gemini and not stored here.
- **Privacy:** the whole PDF goes to Google, with your name, address and IBAN. On Gemini's free tier Google may use what you send to improve its products, and people may review it. Use a key from a paid (billing-enabled) project if that matters to you; categorization sends transaction descriptions to the same key.
- Needs the manual transactions migration (`20261111000000_manual_transactions`) applied.

### Add transactions by hand
- **Migration:** `20261111000000_manual_transactions`. You apply it with `supabase db push --linked`. Apply it before deploying the dashboard with the "+" button; until then adding says the update is missing.
- **Sync:** pull the new code too. The bank sync now skips manual accounts. An older sync would try to fetch them from Enable Banking and log errors.
- Adds `add_manual_transaction` and a `manual` flag on accounts: each source you name ("Fineco", "Cash") gets a hidden manual account. The amount, date and description of a manual transaction can be edited; bank rows stay read-only. Manual accounts don't appear in the accounts list or in net worth.
- **Roll back:** revert the dashboard and the sync first, then `supabase/rollbacks/20261111000000_manual_transactions.down.sql`. This deletes every transaction you added by hand.

### Delete a holding
- **Migration:** `20261110000000_delete_holding`. You apply it with `supabase db push --linked`. Apply it before deploying the dashboard that has the Delete button; until then deleting says the update is missing.
- Adds `delete_holding`, which deletes one of your investments or crypto holdings for good, with its price history and trades. Its value also leaves your past net worth. Use "Mark as sold" instead for something you really sold.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261110000000_delete_holding.down.sql`. Holdings already deleted stay deleted.

### Adding a holding: no more silent zero, clearer errors
- **Deploy the function:** `supabase functions deploy add-holding`. No migration.
- A holding is refused when it has no valid price or no exchange rate, instead of being saved and shown at 0. A missing rate is fetched on the spot.
- Search and add errors now say what failed, for example that CoinGecko is limiting requests.

### Exchange rates for every currency
- **No migration, no deploy:** `fx-sync.js` now stores every currency Frankfurter publishes (about 30 rows a day) instead of USD, GBP and CHF. A holding that showed 0 because its currency had no rate, CAD for example, gets its value at the next sync.

### Splitwise corrections
- **Migration:** `20261109000000_splitwise_corrections`. You apply it with `supabase db push --linked`. Apply it before using corrections in the dashboard; until then that screen says the update is missing, and importing still works.
- Adds `apply_splitwise_corrections`, which applies the rows you tick: added late, edited or removed in Splitwise. A removed row linked to a bank transaction clears its personal amount; an edited one recalculates it. Undo does not cover corrections.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261109000000_splitwise_corrections.down.sql`. Corrections already applied stay.

### Past-price backfill removed
- **No migration.** `backfill-price-history.js` no longer runs in the sync: total return needs only the latest price, and the script could take up to 8 minutes per sync. The `price_history` table and its rows stay, harmlessly.
- `COINGECKO_DEMO_API_KEY` is no longer used; you can remove it from `.env`.
- **Roll back:** revert the code.

### Your trades, for real performance (database part)
- **Migration:** `20261108000000_holding_trades`. You apply it with `supabase db push --linked`. Apply it before deploying the dashboard that uses it; until then that dashboard says the update is missing.
- Adds the `holding_trades` table (your buys and sells, only you can see or change them). `holding_performance` now also returns holdings sold to zero that have trades.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261108000000_holding_trades.down.sql`. This deletes your trades, so export them first.

### Past prices for price returns (backfill)
- **No migration of its own; needs `20261107000000_price_history_and_holding_performance`.** Apply that with `supabase db push --linked` first. Until then the new step prints `price_history not found: apply the latest migration` and does nothing; the rest of the sync is unaffected.
- New `backfill-price-history.js` (removed again later; see above): fetches up to a year of past daily prices (Yahoo for stocks and funds, CoinGecko for coins) into `price_history`, only for holdings that have little of it. It runs as the last step of the daily sync, so a holding you add gets its history on the next sync. To fill everything now, run `node backfill-price-history.js` once (`--force` refetches all). Safe to re-run.
- A symbol Yahoo or CoinGecko will not answer for is counted as failed (`Price history: N filled, M failed, K already complete`) and retried next sync; the dashboard shows "since <date>" for it. CoinGecko's free tier is slow and rate limited (about 8 seconds between coins). An optional free demo key in `COINGECKO_DEMO_API_KEY` (see `.env.example`) helps.
- Nothing is written to `portfolio_snapshots` or `crypto_snapshots`, so net worth history is unchanged.
- **Roll back:** revert the code. The table stays until you run the migration's rollback.

### Price return for Portfolio and Crypto (database part)
- **Migration:** `20261107000000_price_history_and_holding_performance`. You apply it with `supabase db push --linked`; nothing applies it for you. Safe to apply before or after updating the dashboard.
- Adds the `price_history` table (past market prices, readable when signed in, written only by the sync) and the `holding_performance(p_from, p_last_move)` function the dashboard will call for price returns. It reads your holdings and prices only and writes nothing. `price_history` is never used by net worth.
- Until the price backfill ships (next release) the function works from your snapshots alone: ranges that start before your first snapshot show "since <date>".
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261107000000_price_history_and_holding_performance.down.sql` (drops the function and the table; backfilled prices are lost and can be fetched again).

### Setup no longer asks for the dashboard address
- **No migration beyond `20261106000000_dashboard_origins`** (apply with `supabase db push --linked` first, then `supabase functions deploy`).
- `./setup.sh` has no "Dashboard address" question any more. Your dashboard registers its own address in `dashboard_origins` when the owner signs in, the Edge Functions allow those addresses in CORS, and a bank link returns to the address that started it. For GitHub installs setup prints the three Vercel values, then waits for that first sign-in and ends with `Done! Open <address>, sign in as <email>`.
- Existing installs: nothing breaks. `FRONTEND_URL` stays set and is still accepted; your dashboard registers itself on the next sign-in once it runs the matching my-wealth-view version. `./setup.sh --dashboard-url https://...` still works if bank linking ever returns to the wrong address.
- To forget a registered address (an old domain): in the Supabase SQL editor, `delete from dashboard_origins where origin = 'https://old.example.com';`.
- **Roll back:** revert the code first, then `supabase/rollbacks/20261106000000_dashboard_origins.down.sql`.

### Accounts show the bank's name and logo
- **Migration:** `20261105000000_account_bank`. Apply it with `supabase db push --linked` BEFORE redeploying `bank-consent-callback` (`supabase functions deploy bank-consent-callback`), then update the dashboard. A callback deployed before the migration fails every bank link, because it writes columns that don't exist yet.
- `accounts` gains `bank_name`, `bank_country` and `bank_logo`, and `v_bank_accounts_latest` exposes `bank_name`, `bank_logo` and `bank_country`. Before, an account was named after the holder name Enable Banking returns.
- Banks you already connected keep their current name until their next Renew access, which fills in the bank.
- **Roll back:** revert the code first, then `supabase/rollbacks/20261105000000_account_bank.down.sql`.

### A bank that closes access early shows Renew
- **No migration. Nothing to do** beyond redeploying the sync.
- When a bank ends its consent before the date it gave (Enable Banking answers `EXPIRED_SESSION`), the balance sync sets that account's consent end to today, so the Renew banner shows at once and the daily consent push fires. A later date is never set, and other 401/403 errors (a bad key, an inactive app) change nothing.
- The sync log ends with `Marked N account(s) for renewal (bank closed access early)` when this happens.

### Bank access push also when the banner appears
- **No migration. No action.** The push now also fires 14 days before access ends, the day the Accounts banner appears.

### Banks keep syncing after Renew access
- **Migration:** `20261104000000_account_eb_uid`. Apply it with `supabase db push --linked`, then redeploy `bank-consent-callback` (`supabase functions deploy bank-consent-callback`). Until the migration is applied the sync logs a warning and keeps using the old ids, so a renewed bank still stops when its old consent ends.
- Enable Banking gives an account a new id when you renew access. The old id stops working when the old consent ends, so a renewed bank silently stopped updating. The new id is now stored in `accounts.eb_account_uid` and the sync uses it; history stays on the same account.
- The balance sync fills in a missing bank id (`identification_hash`) once per older account, so a later renewal finds it instead of adding a duplicate account.
- The sync log ends with `EB refused N account(s)` when the bank rejects an account id.
- **Roll back:** revert the code first, then `supabase/rollbacks/20261104000000_account_eb_uid.down.sql`.

### Set up from the browser with GitHub Codespaces
- **No migration. Nothing to do on an existing install.**
- `.devcontainer/devcontainer.json`: Node 22, GitHub CLI and Supabase CLI, ready in a Codespace. README has an "Open in GitHub Codespaces" button.
- In a Codespace, `setup.sh` signs `gh` in as you (the Codespace's own token can't write secrets). Run from a repo you don't own, it offers to fork it to your account and sets the sync up on the fork. It also says how to upload the `.pem`, and reminds you to delete the Codespace afterwards since it holds your keys.

### setup.sh can turn on the GitHub Actions sync
- **No migration.**
- `setup.sh` now asks where the sync runs. With GitHub Actions it needs the GitHub CLI and your fork (it checks you are an admin of the repo), writes every secret the workflow reads, sets `SYNC_ON_GITHUB=true` and enables Actions. Docker is then not needed: the functions deploy with `--use-api`.
- The choice is saved as `SYNC_ON` in `.env` and offered as the default on the next run. The frontend `.env` is skipped when there is no local frontend checkout (Vercel keeps its own settings).
- Fixed: a re-run with an existing login crashed on its last line (`LOGIN_EMAIL: unbound variable`).

### Optional: run the sync on GitHub Actions
- **No migration** (needs `20261102000000_sync_cursors` from the previous release). Nothing changes for Docker, cron or launchd installs.
- New workflow `.github/workflows/sync.yml`, off until the repository variable `SYNC_ON_GITHUB` is `true`. See Scheduling in the README for the secrets it needs.
- `node scheduler.js --once <sync|notify|consent>` runs one job and exits, non-zero if a step failed; the workflow uses it. The job lists moved to `jobs.js`, shared with the Docker scheduler.

### Sync progress is stored in the database
- **Migration:** `20261102000000_sync_cursors`. Apply it, then redeploy the sync jobs.
- Where each account's transaction sync got to used to live only in `last-sync.json` next to the scripts. It now lives in the `sync_cursors` table too, so the sync can run on a machine that keeps no files between runs (the GitHub Actions option coming next).
- Nothing to move by hand: the next sync reads your existing `last-sync.json` and copies it into the table. The file is still written as a local copy, and the sync keeps working from it if the migration isn't applied yet (with a warning in the log).

### Add investments and crypto from the dashboard
- **Migration:** `20261101000000_holdings_self_service`. Apply with `supabase db push --linked`. **Deploy the new function:** `supabase functions deploy add-holding`.
- Before, `portfolio_holdings` and `crypto_holdings` could only be filled in SQL. The migration lets a signed-in user add, edit and delete their own rows (prices stay read-only), allows `Manual` as a crypto source, and removes the `Trade Republic` default broker.
- The new `add-holding` Edge Function searches Yahoo Finance and CoinGecko and saves a holding with today's price. The dashboard screen that uses it ships in my-wealth-view.
- A holding added by name or ticker has no ISIN; its Yahoo symbol is stored in the `isin` column instead.
- Holdings quoted in pence (`GBp`, London listings) are now priced in GBP. Before, they failed every day with "No fx_rates row for currency GBp".
- **Roll back:** `supabase/rollbacks/20261101000000_holdings_self_service.down.sql` (fails while a `Manual` crypto row exists).

### Small setup fixes
- **No migration. Nothing to do.**
- `run-daily-sync.sh` and `run-notify.sh` use the `node` on your PATH, falling back to Homebrew's `/opt/homebrew/bin/node` (cron and launchd start with a bare PATH). Set `NODE=/path/to/node` to pick one. Before, the Homebrew path was hard-coded, so Linux and Intel Macs failed.
- `SESSION_VALID_UNTIL` is gone from `.env.example`: no script read it (bank access is always requested for 180 days). An old line in your `.env` is harmless.
- `setup.sh` no longer prints the new database password: nothing needs it later, and it stayed in the terminal history.

### setup.sh can be run again, and resets your password
- **No migration.**
- Re-running `./setup.sh` used to overwrite both `.env` files and ask for everything again (Coinbase keys and hand edits were lost). Now it reads `.env` first, keeps the project, login, Enable Banking key, VAPID keys and Gemini key it finds, and merges what it writes, so keys it doesn't manage stay. It still pushes new migrations and redeploys the functions, so a re-run is also an easy upgrade.
- `./setup.sh --reset-password` sets a new password for your login (the app has no "forgot password" screen).
- **Docker installs:** `.env` now gets `VITE_VAPID_PUBLIC_KEY`, which `docker-compose.yml` passes to the dashboard build. Before, setup never wrote it, so push notifications could not subscribe on a Docker install. Add it by hand (same value as `VAPID_PUBLIC_KEY`) or re-run `./setup.sh`, then `docker compose up -d --build`.
- `.env` also gets `FRONTEND_URL`, offered as the default on the next run.

### Reminder before a bank's access expires
- **No migration. Redeploy the sync jobs.** Cron and launchd installs: add a daily `node consent-notice.js` (see Scheduling in the README).
- Bank access (PSD2 consent) lasts 180 days, then the bank silently stops syncing. `consent-notice.js` now sends a push notification 7 days, 1 day and on the day a bank's access ends; the dashboard's Accounts page shows a banner from 14 days before (frontend change).
- The Docker scheduler runs it at start and then daily, so restarting the container on a reminder day sends that day's reminder again.
- `notify-worth-it.js` now shares its push code with it (`push.js`); behavior is unchanged.

### .env is checked before the sync starts
- **No migration. Redeploy the sync jobs.**
- The Docker scheduler and `run-daily-sync.sh` now run `env-check.js` first. A missing or wrong value (no secret key, the publishable key pasted as the secret one, an unreadable `.pem`, no `USER_ID`) stops the sync with one line naming the variable, instead of every script failing on its own. Optional features that are off (Gemini, push notifications, a half-set Coinbase key) are listed as warnings.
- Check by hand any time: `node env-check.js`.
- `sync-crypto-coinbase.js` no longer fails when Coinbase isn't configured; it skips.

### Setup switches off public sign-ups by itself
- **Nothing to do on an existing install** if you already switched sign-ups off (see the next section).
- `setup.sh` now turns them off with `supabase config push`, using a temporary config that declares only `enable_signup = false`, so no other project setting is changed. It checks the result and falls back to the dashboard instructions if the push fails.

### Your rules no longer depend on Gemini
- **No migration. Redeploy the sync jobs.**
- Before, `categorize.js` and `classify-type.js` stopped before doing anything if `GEMINI_API_KEY` was missing, so your category rules didn't run either. A Gemini error (quota, outage) also stopped the run.
- Now, without a key, `categorize.js` applies your rules to every uncategorized transaction and `classify-type.js` marks transfers One-time. If Gemini fails mid-run, the same fallback runs and the script still exits with an error so it shows in your logs. `categorize-splitwise.js` skips with a warning.
- The key stays recommended: without it, transactions no rule matches stay uncategorized and subscriptions are not detected.

### A newly linked bank shows its transactions within minutes
- **No migration. Redeploy the sync jobs** (`docker compose up -d --build`).
- Before, linking a bank stored its balance right away but its transactions only at the next 6-hour sync.
- Now the Docker scheduler checks every 5 minutes for banks linked in the last hour that have never synced, pulls their last 90 days and categorizes them. Other accounts are not called, so the banks' daily call limits are unaffected. If that first sync keeps failing, it stops retrying after an hour and the regular sync takes over.
- Cron and launchd installs are unchanged: run `bash run-daily-sync.sh` once after linking, or wait for the next run.

### Switch off public sign-ups (existing installs read this)
- **No migration. One step in your Supabase dashboard.**
- Supabase leaves sign-ups open on every new project. The app has no sign-up screen, but anyone who finds your project URL and its public key can still create an account through the Auth API. They could then call the bank functions and use up your Enable Banking quota.
- **Do this:** Authentication -> Sign In / Providers -> User Signups -> turn off *Allow new users to sign up* -> Save. Your own login keeps working.
- `setup.sh` now creates your login and `USER_ID` for you and walks you through this step. `start-bank-consent` and `list-banks` also validate their input, and `start-bank-consent` refuses a sixth open consent request per user (redeploy with `supabase functions deploy`).

### Re-importing Splitwise keeps your edits
- **Migration:** `20261031000000_splitwise_import_keeps_edits`. Apply with `supabase db push --linked`.
- **Why:** importing the same group and date range again deleted every row in the range and reinserted it from the file, so a description or category you had edited was lost.
- **Effect:** rows already stored (matched by fingerprint) keep their edited description and category; an empty category is filled from the file. New rows are inserted and rows the file no longer has are deleted. An expense you change in Splitwise itself gets a new fingerprint, so edits on it are still lost.
- **Roll back:** the matching file in `supabase/rollbacks/`.

### EUR views keep every row, net worth no longer dips
- **Migrations:** `20261029000000_fx_eur_fallback`, `20261030000000_net_worth_carry_forward`. Apply with `supabase db push --linked`.
- **Why:** an EUR row dated before the first stored FX rate used to vanish from every euro view. A holding with no price on the latest day made that whole day's net worth dip.
- **Effect:** EUR rows always stay. A non-EUR currency with no rate now shows a NULL euro amount instead of disappearing. A holding keeps its last known value until it is priced again; a sold holding drops out the day after its last snapshot.
- **Roll back:** the matching files in `supabase/rollbacks/`.

### Card refunds pair with their purchase more often
- **No migration. Redeploy the sync jobs.**
- A refund whose `creditor_name` is the account holder, or whose charge has no `creditor_name`, now pairs by the merchant in the remittance text. Existing unpaired refunds pair on the next daily classify run.

### Coinbase holdings that reach zero are zeroed
- **No migration. Redeploy the sync jobs.**
- Before, an account that dropped to exactly 0 was skipped, so its old amount stayed in `crypto_holdings` and kept being priced. Now its amount is set to 0 on the next Coinbase sync. A missing or malformed balance is still skipped, never read as zero.

### Schema files cleanup (existing installs read this)
- Rollback files moved from `supabase/migrations/` to `supabase/rollbacks/`, so `supabase db push --linked` no longer trips over them.
- `merchant_aliases` (`20261027000000`) and `net_worth_daily_bonds` (`20261028000000`) were added to this repo. If you already created them by hand or from the frontend repo, `supabase db push --linked` fails with `Found local migration files to be inserted before the last migration on remote database` and suggests `--include-all`. Do not use `--include-all`: it would re-run the `create table` and fail with "already exists". Mark them applied instead: `supabase migration repair --status applied 20261027000000 20261028000000`, then `supabase db push --linked` again. (Tested on a local Supabase: after the repair, push reports the database is up to date.)

## Known limits
- Portfolio, crypto and notification scripts are single-user (`USER_ID`). Bank sync is multi-user.
- Nothing trims old data. Daily net worth snapshots, FX rates and transactions are kept forever. The dashboard reads at most 1000 rows per query, which daily net worth would reach after about 2.6 years of daily snapshots.
