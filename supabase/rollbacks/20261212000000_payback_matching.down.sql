-- Rolls back 20261212000000_payback_matching. Bills settled by a payback stay settled, and payments
-- recorded as paybacks stay transfers; only the links and the columns that remember them go.
drop function if exists public.undo_payback(uuid, text, boolean);
drop function if exists public.record_payback(uuid, text, text, boolean);
drop function if exists public.payback_candidates(integer);
drop table if exists public.payer_links;
drop function if exists public.payer_name_of(text, text);
drop function if exists public.payer_key(text);
drop index if exists public.transactions_settled_by_idx;
alter table public.transactions
  drop column if exists settled_by_ref,
  drop column if exists settled_by_account,
  drop column if exists payback_contact;
