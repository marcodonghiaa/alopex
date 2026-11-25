-- H267: six security definer functions searched only `public`. With pg_temp not listed, Postgres
-- searches a session's temp schema first for tables, so a session able to create temp tables
-- could shadow `accounts` or `transactions` inside them. Put pg_temp last, as the splitwise review
-- functions and delete_holding already do. Only the setting changes, not the bodies; anyone
-- redefining one of these later must keep it (schema-invariants-db.test.js checks).
alter function public.add_manual_debt(text, numeric, text) set search_path = public, pg_temp;
alter function public.add_manual_transaction(date, text, numeric, text, text, text, text) set search_path = public, pg_temp;
alter function public.set_account_type(uuid, text) set search_path = public, pg_temp;
alter function public.set_holding_quantity(text, text, numeric, text) set search_path = public, pg_temp;
alter function public.set_manual_balance(uuid, numeric) set search_path = public, pg_temp;
alter function public.upsert_detected_streams(uuid, jsonb) set search_path = public, pg_temp;
