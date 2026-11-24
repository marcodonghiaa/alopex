-- Rollback of 20270108000000_drop_v_cd_holdings: v_cd_holdings as in 20261029000000_fx_eur_fallback.
create or replace view public.v_cd_holdings with (security_invoker = true) as
 select c.id, c.user_id, c.label, c.bank_label, c.currency, c.principal, c.annual_rate,
    c.start_date, c.maturity_date,
    (c.maturity_date <= current_date) as is_matured,
    (least(current_date, c.maturity_date) - c.start_date) as days_elapsed,
    c.principal * power(1 + c.annual_rate, (least(current_date, c.maturity_date) - c.start_date)::numeric / 365.25) as current_value_native,
    (c.principal * power(1 + c.annual_rate, (least(current_date, c.maturity_date) - c.start_date)::numeric / 365.25)) * fx.rate_to_eur as current_value_eur
   from public.cd_holdings c
     left join lateral (
        select coalesce(
          (select fx_rates.rate_to_eur
           from public.fx_rates
           where fx_rates.currency = c.currency and fx_rates.date <= current_date
           order by fx_rates.date desc
           limit 1),
          case when c.currency = 'EUR' then 1::numeric end
        ) as rate_to_eur
      ) fx on true;
revoke all on public.v_cd_holdings from anon;
grant select on public.v_cd_holdings to authenticated, service_role;
comment on table public.cd_holdings is null;
