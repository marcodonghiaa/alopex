-- v_income_vs_expenses_monthly counts imported spend history.
--
-- Spending and Budgets (v_spend_by_category_monthly) count a month's imported totals
-- (spend_history) when that month has no bank spend, but this view did not, so Cash flow, Reports,
-- Income and Transactions showed no spending for imported months. Expenses are now the sum of
-- v_spend_by_category_monthly (bank spend, Splitwise shares, and imported totals for months
-- without bank spend), so both views always agree. Income and the columns are unchanged.

create or replace view public.v_income_vs_expenses_monthly with (security_invoker = true) as
 select m.user_id, m.month, sum(m.income_eur) as income_eur, sum(m.expenses_eur) as expenses_eur
   from (
     select user_id,
        (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date as month,
        (case when flow_type = 'income' and personal_signed_amount_eur > 0 then personal_signed_amount_eur else 0 end) as income_eur,
        0::numeric as expenses_eur
       from public.v_transactions_eur
     union all
     select user_id, month, 0::numeric, spend_eur
       from public.v_spend_by_category_monthly
   ) m
  group by m.user_id, m.month
  order by m.month;
