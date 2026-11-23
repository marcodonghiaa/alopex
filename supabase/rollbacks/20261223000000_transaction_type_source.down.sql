-- Undoes 20261223000000_transaction_type_source: drops the trigger, its function and the column.
-- Types you set by hand stay as they are, but the sync, rules and AI may overwrite them again.
drop trigger if exists trg_keep_manual_transaction_type on public.transactions;
drop function if exists public.keep_manual_transaction_type();
alter table public.transactions drop column if exists transaction_type_source;
