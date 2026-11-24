-- Rollback of 20270115000000_definer_search_path_pg_temp: these functions search only public again.
alter function public.add_manual_debt(text, numeric, text) set search_path = public;
alter function public.add_manual_transaction(date, text, numeric, text, text, text, text) set search_path = public;
alter function public.set_account_type(uuid, text) set search_path = public;
alter function public.set_holding_quantity(text, text, numeric, text) set search_path = public;
alter function public.set_manual_balance(uuid, numeric) set search_path = public;
alter function public.upsert_detected_streams(uuid, jsonb) set search_path = public;
