-- Rollback of 20261218000000_broker_matching. Matched rows keep the flow and category they got
-- (transfer / income / Taxes); their flow source goes back to 'default', so post-sync may set
-- buys and deposits to spend/income again. Names go back to the bank's (none).
drop function if exists public.match_broker_rows(uuid);
drop function if exists public.broker_sources();
update public.transactions set flow_source = 'default' where flow_source = 'broker';
alter table public.transactions drop constraint if exists transactions_flow_source_check;
alter table public.transactions add constraint transactions_flow_source_check
  check (flow_source in ('user', 'legacy', 'rule', 'own_account', 'pair', 'bank', 'default'));

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
create or replace function public.restrict_transaction_updates()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_manual boolean := exists (select 1 from accounts where uid = old.account_uid and manual);
begin
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

create or replace function public.mark_manual_category()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.category_source := 'manual';
  return new;
end;
$function$;

-- The view as 20261209000000 left it; then the columns can go.
create or replace view public.v_transactions_eur with (security_invoker = true) as
 select t.user_id,
    t.entry_reference,
    t.account_uid,
    t.booking_date,
    t.category,
    coalesce(t.custom_name, t.creditor_name) as creditor_name,
    t.currency,
    t.amount,
    (case when t.credit_debit_indicator = 'DBIT' then -1 else 1 end)::numeric * t.amount * fx.rate_to_eur as signed_amount_eur,
    t.transaction_type,
    t.credit_debit_indicator,
    t.created_at,
    t.worth_it,
    (case when t.credit_debit_indicator = 'DBIT' then -1 else 1 end)::numeric * coalesce(t.personal_amount, t.amount) * fx.rate_to_eur as personal_signed_amount_eur,
    coalesce(t.flow_type, case when t.credit_debit_indicator = 'DBIT' then 'spend' else 'income' end) as flow_type,
    t.personal_amount,
    t.owed_by,
    t.owed_settled,
    t.settled_at,
    t.refund_of,
    t.note,
    t.tags,
    coalesce(t.custom_name, t.debtor_name) as payer_name
   from public.transactions t
     left join lateral (
        select coalesce(
          (select fx_rates.rate_to_eur
           from public.fx_rates
           where fx_rates.currency = t.currency and fx_rates.date <= t.booking_date
           order by fx_rates.date desc
           limit 1),
          case when t.currency = 'EUR' then 1::numeric end
        ) as rate_to_eur
      ) fx on true
   where t.deleted_at is null;

drop index if exists public.transactions_broker_ref_idx;
alter table public.transactions
  drop column if exists broker_label,
  drop column if exists broker_ref;
