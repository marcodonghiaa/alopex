-- Net worth numbers agree (hardening batch G).
--
-- H099: a manual account in another currency was converted on the Accounts page at the rate of
-- the day its balance was typed in, while net worth converts it at the latest rate. The Accounts
-- view now uses the latest rate too, so both pages show the same euros. Columns unchanged.
--
-- H091: an imported month (spend_history) was hidden by any bank row flagged 'spend', even a
-- share of 0 paid entirely for others. It is now replaced only by spend the live branch counts.
-- Columns unchanged.

create or replace view public.v_bank_accounts_latest with (security_invoker = true) as
 select distinct on (a.user_id, a.uid)
    a.user_id, a.uid, a.label, a.iban, a.currency, a.consent_valid_until,
    e.snapshot_date, e.amount,
    case when a.manual then e.amount * coalesce(
        (select r.rate_to_eur from public.fx_rates r
         where r.currency = e.currency and r.date <= current_date order by r.date desc limit 1),
        case when e.currency = 'EUR' then 1::numeric end)
      else e.amount_eur end as amount_eur,
    a.bank_name, a.bank_logo, a.bank_country,
    a.account_type, a.manual, a.sync_error, a.sync_error_at
   from public.accounts a
     left join public.v_net_worth_eur e on e.user_id = a.user_id and e.account_uid = a.uid
   where not a.manual or e.snapshot_date is not null
   order by a.user_id, a.uid, e.snapshot_date desc nulls last;

create or replace view public.v_spend_by_category_monthly with (security_invoker = true) as
 select u.user_id, u.month, u.category, sum(u.spend_eur) as spend_eur
   from (
 select live.user_id, live.month, live.category, sum(live.spend_eur) as spend_eur
   from (
     select user_id,
        (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date as month,
        coalesce(category, 'Uncategorized'::text) as category,
        (- personal_signed_amount_eur) as spend_eur
       from public.v_transactions_eur
      where ((personal_signed_amount_eur < (0)::numeric) and (flow_type = 'spend'::text))
     union all
     select user_id,
        (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date,
        coalesce(category, 'Uncategorized'::text),
        amount_eur
       from public.v_splitwise_eur
   ) live
  group by live.user_id, live.month, live.category
 union all
 select h.user_id, h.month, h.category, h.spend_eur
   from public.spend_history h
  where not exists (
    select 1 from public.v_transactions_eur t
     where t.user_id = h.user_id
       and t.flow_type = 'spend'
       and t.personal_signed_amount_eur < 0
       and (date_trunc('month'::text, (t.booking_date)::timestamp with time zone))::date = h.month
  )
   ) u
  group by u.user_id, u.month, u.category;
