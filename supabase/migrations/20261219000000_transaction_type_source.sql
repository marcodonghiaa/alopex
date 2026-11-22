-- Remembers a transaction type you set by hand (thread "Sync transaction edits to subscriptions").
-- Like category_source for categories: a signed-in user's change to transaction_type marks it
-- 'manual', and from then on the sync, rules and the AI (service role) keep your choice. The
-- subscription detector skips charges you marked One-time, so they never rebuild a subscription.
-- Rows from before have no marker (who set their type is unknown): pick the type again to keep it.
alter table public.transactions
  add column if not exists transaction_type_source text
  check (transaction_type_source in ('manual'));

create or replace function public.keep_manual_transaction_type()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if auth.role() = 'authenticated' then
    -- Yours when you change it, or pick the type it already has (sent with source 'manual').
    -- An empty type is nobody's: the AI may fill it again.
    if new.transaction_type is null then
      new.transaction_type_source := null;
    elsif new.transaction_type is distinct from old.transaction_type
      or new.transaction_type_source is not distinct from 'manual' then
      new.transaction_type_source := 'manual';
    else
      new.transaction_type_source := old.transaction_type_source;
    end if;
  elsif old.transaction_type_source = 'manual' then
    -- Anything but you (sync, rules, AI, maintenance) leaves your choice as it is.
    new.transaction_type := old.transaction_type;
    new.transaction_type_source := 'manual';
  end if;
  return new;
end;
$function$;

-- Trigger function itself must not be directly callable via RPC.
revoke execute on function public.keep_manual_transaction_type() from public, anon, authenticated;

drop trigger if exists trg_keep_manual_transaction_type on public.transactions;
create trigger trg_keep_manual_transaction_type
  before update of transaction_type, transaction_type_source on public.transactions
  for each row
  execute function public.keep_manual_transaction_type();
