-- v_income_vs_expenses_monthly as before 20261226000000: imported spend history is not counted.
create or replace view public.v_income_vs_expenses_monthly with (security_invoker = true) as
 select m.user_id, m.month, sum(m.income_eur) as income_eur, sum(m.expenses_eur) as expenses_eur
   from (
     select user_id,
        (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date as month,
        (case when flow_type = 'income' and personal_signed_amount_eur > 0 then personal_signed_amount_eur else 0 end) as income_eur,
        (case when flow_type = 'spend' and personal_signed_amount_eur < 0 then - personal_signed_amount_eur else 0 end) as expenses_eur
       from public.v_transactions_eur
     union all
     select user_id,
        (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date,
        0::numeric,
        amount_eur
       from public.v_splitwise_eur
   ) m
  group by m.user_id, m.month
  order by m.month;
