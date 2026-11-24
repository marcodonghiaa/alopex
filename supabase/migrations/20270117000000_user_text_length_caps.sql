-- H269: two columns users write directly had no length limit.
--
-- 1. transactions.category: add_manual_transaction caps it at 100 characters, but a direct PATCH
--    skipped that. A signed-in user's new or changed category is now capped at 100 too. Checked on
--    change only (as rule text in 20261211000000), so a row stored before with a longer category
--    blocks no other edit, and only for the API roles: the sync and rules (service role) and the
--    definer RPCs (capped themselves) are never refused, so no sync can fail on it.
create or replace function public.transactions_category_length()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon')
     and (tg_op = 'INSERT' or new.category is distinct from old.category)
     and char_length(new.category) > 100 then
    raise exception 'category must be at most 100 characters'
      using errcode = 'check_violation', constraint = 'transactions_category_length';
  end if;
  return new;
end $$;

drop trigger if exists transactions_category_length on public.transactions;
create trigger transactions_category_length
  before insert or update of category on public.transactions
  for each row execute function public.transactions_category_length();

-- 2. pending_bank_consents.origin: the Edge Function stores an allowed dashboard origin (an https
--    host name, at most about 270 characters), but a user could insert their own row with any text.
--    Rows longer than 300 can't come from the app and live 15 minutes at most: delete them, then
--    add the cap and validate it (the table is small, so the brief lock is harmless).
delete from public.pending_bank_consents where char_length(origin) > 300;
alter table public.pending_bank_consents drop constraint if exists pending_bank_consents_origin_length;
alter table public.pending_bank_consents add constraint pending_bank_consents_origin_length
  check (origin is null or char_length(origin) <= 300) not valid;
alter table public.pending_bank_consents validate constraint pending_bank_consents_origin_length;
