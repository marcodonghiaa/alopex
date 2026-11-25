-- Rollback of 20270117000000_user_text_length_caps: no length cap on transactions.category or
-- pending_bank_consents.origin. Deleted over-long pending consents are not brought back.
drop trigger if exists transactions_category_length on public.transactions;
drop function if exists public.transactions_category_length();
alter table public.pending_bank_consents drop constraint if exists pending_bank_consents_origin_length;
