-- Restores fx_backfill_needed from 20261217000000: bank transactions only.

create or replace function public.fx_backfill_needed()
returns table (currency text, from_date date, to_date date)
language sql
stable
security definer
set search_path = ''
as $function$
  with need as (
    select t.currency, min(t.booking_date) as first_day
    from public.transactions t
    where t.deleted_at is null
      and t.booking_date is not null
      and t.currency ~ '^[A-Z]{3}$'
      and t.currency <> 'EUR'
    group by t.currency
  )
  select n.currency, n.first_day, coalesce(f.first_rate, current_date)
  from need n
  left join lateral (select min(r.date) as first_rate from public.fx_rates r where r.currency = n.currency) f on true
  where f.first_rate is null or n.first_day < f.first_rate;
$function$;
