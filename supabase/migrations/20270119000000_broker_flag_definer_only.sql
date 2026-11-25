-- H254: the bank-field guard (restrict_transaction_updates), the 'manual' category mark
-- (mark_manual_category) and the 'user' flow mark (flow_source_user) all stood aside whenever the
-- session setting alopex.broker_match was on. match_broker_rows and move_category set it, but any
-- role that can run SQL can set a custom setting too, so a future user-callable invoker function
-- or a direct database login could have switched the guard off. The flag now counts only inside
-- definer code: the triggers' WHEN skips them when the flag is on and the statement runs as a
-- function owner (current_user inside match_broker_rows or move_category), never when it runs as
-- the signed-in session itself ('authenticated' or 'anon'). The functions lose their own check.
-- Bodies as in 20270110000000 (restrict_transaction_updates) and 20261220000000 (the other two).
create or replace function public.restrict_transaction_updates()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user text[] := array[
    'category', 'category_source', 'transaction_type', 'transaction_type_source', 'worth_it',
    'worth_it_prompted_at', 'personal_amount', 'owed_by', 'owed_settled', 'settled_at', 'flow_type',
    'flow_source', 'deleted_at', 'import_batch_id', 'custom_name', 'note', 'tags', 'payback_contact',
    'settled_by_account', 'settled_by_ref'];
  v_bank text[] := array[
    'amount', 'currency', 'credit_debit_indicator', 'creditor_name', 'booking_date', 'value_date'];
  v_free text[];
begin
  v_free := v_user || 'merchant_key'::text
    || case when exists (select 1 from public.accounts where uid = old.account_uid and manual)
         then v_bank else '{}'::text[] end;
  if (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free)
     or (new.merchant_key is not null and new.merchant_key is distinct from old.merchant_key)
  then
    raise exception 'Bank-provided fields on transactions cannot be changed';
  end if;
  return new;
end;
$function$;
revoke execute on function public.restrict_transaction_updates() from public, anon, authenticated;

create or replace function public.flow_source_user() returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if tg_op = 'INSERT' or new.flow_type is distinct from old.flow_type
     or new.flow_source is distinct from old.flow_source then
    new.flow_source := case when new.flow_type is null then null else 'user' end;
  end if;
  return new;
end;
$$;
revoke execute on function public.flow_source_user() from public, anon, authenticated;

create or replace function public.mark_manual_category()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  new.category_source := 'manual';
  return new;
end;
$function$;
revoke execute on function public.mark_manual_category() from public, anon, authenticated;

drop trigger if exists trg_restrict_transaction_updates on public.transactions;
create trigger trg_restrict_transaction_updates
  before update on public.transactions
  for each row
  when (auth.role() = 'authenticated'::text
    and (current_setting('alopex.broker_match', true) is distinct from 'on' or current_user in ('authenticated', 'anon')))
  execute function public.restrict_transaction_updates();

drop trigger if exists trg_mark_manual_category on public.transactions;
create trigger trg_mark_manual_category
  before update of category on public.transactions
  for each row
  when (auth.role() = 'authenticated'::text and new.category is distinct from old.category
    and (current_setting('alopex.broker_match', true) is distinct from 'on' or current_user in ('authenticated', 'anon')))
  execute function public.mark_manual_category();

drop trigger if exists trg_flow_source_user on public.transactions;
create trigger trg_flow_source_user
  before insert or update of flow_type, flow_source on public.transactions
  for each row
  when (auth.role() = 'authenticated'::text
    and (current_setting('alopex.broker_match', true) is distinct from 'on' or current_user in ('authenticated', 'anon')))
  execute function public.flow_source_user();
