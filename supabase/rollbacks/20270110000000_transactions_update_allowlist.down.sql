-- Rollback of 20270110000000_transactions_update_allowlist: restrict_transaction_updates as in
-- 20261220000000_broker_matching (a denylist: columns added later are writable by the user).
create or replace function public.restrict_transaction_updates()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_manual boolean := exists (select 1 from accounts where uid = old.account_uid and manual);
begin
  -- match_broker_rows (below) labels bank rows for the caller; nothing else turns this on.
  if current_setting('alopex.broker_match', true) = 'on' then
    return new;
  end if;
  if new.entry_reference is distinct from old.entry_reference
     or new.account_uid is distinct from old.account_uid
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at
     or new.raw is distinct from old.raw
     or new.debtor_name is distinct from old.debtor_name
     or new.remittance_info is distinct from old.remittance_info
     or new.bank_transaction_code is distinct from old.bank_transaction_code
     or new.own_counterparty is distinct from old.own_counterparty
     or new.refund_of is distinct from old.refund_of
     or new.broker_ref is distinct from old.broker_ref
     or new.broker_label is distinct from old.broker_label
     or (new.merchant_key is not null and new.merchant_key is distinct from old.merchant_key)
     or (not v_manual and (
          new.amount is distinct from old.amount
       or new.currency is distinct from old.currency
       or new.credit_debit_indicator is distinct from old.credit_debit_indicator
       or new.creditor_name is distinct from old.creditor_name
       or new.booking_date is distinct from old.booking_date
       or new.value_date is distinct from old.value_date))
  then
    raise exception 'Bank-provided fields on transactions cannot be changed';
  end if;
  return new;
end;
$function$;
