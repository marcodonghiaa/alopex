-- One shared euro rate lookup: the latest rate on or before the date, and 1 for EUR when fx_rates
-- has no EUR row. Views and functions had this pasted in about ten places; each uses this helper
-- the next time it is replaced, so a future fx fix lands once. Plain SQL, stable and without a SET
-- clause so the planner inlines it and keeps using idx_fx_rates_currency_date. Runs as the caller
-- (fx_rates is readable by every signed-in user).
create or replace function public.fx_rate_to_eur(p_currency text, p_on date)
returns numeric
language sql
stable
as $$
  select coalesce(
    (select fx.rate_to_eur from public.fx_rates fx
      where fx.currency = p_currency and fx.date <= p_on order by fx.date desc limit 1),
    case when p_currency = 'EUR' then 1::numeric end
  )
$$;
revoke execute on function public.fx_rate_to_eur(text, date) from public, anon;
grant execute on function public.fx_rate_to_eur(text, date) to authenticated, service_role;
