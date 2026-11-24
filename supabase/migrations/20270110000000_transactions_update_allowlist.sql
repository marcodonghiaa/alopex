-- restrict_transaction_updates as in 20261220000000_broker_matching, turned from a denylist into an
-- allowlist: a signed-in user may change only the columns listed below (exactly the ones they could
-- change before), plus the bank fields on a manual account's rows, and may clear merchant_key. Any
-- column added later is server-only (sync, post-sync, service role) until a migration adds it here.
-- The broker matcher's bypass is unchanged.
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
  -- match_broker_rows labels bank rows for the caller; nothing else turns this on.
  if current_setting('alopex.broker_match', true) = 'on' then
    return new;
  end if;
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
