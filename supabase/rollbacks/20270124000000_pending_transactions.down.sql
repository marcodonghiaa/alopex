-- Rollback of 20270124000000_pending_transactions: the pending rows go (the bank books them
-- again under their own ids on the next sync) and the column is dropped from the table.
-- v_transactions_eur keeps its last column: Postgres can't remove a view column with create or
-- replace (see 20270104000000's rollback), so it is recreated reading false instead.
-- Redeploy the previous functions and dashboard first, then run this and:
--   supabase migration repair --status reverted 20270124000000 --linked
delete from public.transactions where pending;
create or replace view public.v_transactions_eur with (security_invoker = true) as
 select t.user_id,
    t.entry_reference,
    t.account_uid,
    t.booking_date,
    t.category,
    coalesce(t.custom_name, t.broker_label, t.creditor_name) as creditor_name,
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
    coalesce(t.custom_name, t.broker_label, t.debtor_name) as payer_name,
    t.creditor_name as bank_creditor_name,
    false as pending
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
alter table public.transactions drop column if exists pending;
