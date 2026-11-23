-- fx_backfill_needed also looks at Splitwise shares not linked to a bank row (the ones
-- v_splitwise_eur converts on their own): an older foreign-currency share had no rate on or before
-- its date, so it got no euro amount and dropped out of spending, cash flow and budgets. Same
-- signature: grants are kept.

create or replace function public.fx_backfill_needed()
returns table (currency text, from_date date, to_date date)
language sql
stable
security definer
set search_path = ''
as $function$
  with need as (
    select t.currency, min(t.booking_date) as first_day
    from (
      select x.currency, x.booking_date from public.transactions x where x.deleted_at is null
      union all
      select s.currency, s.booking_date from public.splitwise_expenses s where s.linked_entry_reference is null
    ) t
    where t.booking_date is not null
      and t.currency ~ '^[A-Z]{3}$'
      and t.currency <> 'EUR'
    group by t.currency
  )
  select n.currency, n.first_day, coalesce(f.first_rate, current_date)
  from need n
  left join lateral (select min(r.date) as first_rate from public.fx_rates r where r.currency = n.currency) f on true
  where f.first_rate is null or n.first_day < f.first_rate;
$function$;
