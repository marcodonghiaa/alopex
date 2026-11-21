-- After a bank's first sync, the Edge Functions queue the next step themselves: post-sync in
-- rounds until nothing is left, then detect-recurring (e2e test 2026-11-20 #7, #9, #13: a new
-- user saw everything Uncategorized and no subscriptions for up to 6 hours).
-- call_edge_function stays database-only (it carries the secret key); this wrapper lets the
-- service role start just these two jobs, through pg_net, so no function waits for another.
create or replace function public.queue_edge_job(job text, round int default 0)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if job = 'post-sync' and round between 1 and 10 then
    return public.call_edge_function('post-sync', jsonb_build_object('catch_up', round));
  elsif job = 'detect-recurring' then
    return public.call_edge_function('detect-recurring');
  end if;
  raise exception 'Not a job that can be queued: % (round %)', job, round;
end;
$function$;

revoke execute on function public.queue_edge_job(text, int) from public, anon, authenticated;
grant execute on function public.queue_edge_job(text, int) to service_role;

-- Foreign currencies whose oldest transaction is older than their oldest stored rate (or that have
-- no rate at all): post-sync fetches those past rates (e2e #8: on a fresh install every older USD
-- row had no euro amount). Service role only: it reads every user's currencies and dates, no amounts.
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

revoke execute on function public.fx_backfill_needed() from public, anon, authenticated;
grant execute on function public.fx_backfill_needed() to service_role;
