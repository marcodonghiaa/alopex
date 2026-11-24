-- Rollback of 20270106000000_fx_rate_to_eur. Roll back 20270107000000_holding_performance_no_price_history first:
-- it calls this function, and Postgres does not stop the drop (plpgsql records no dependency).
drop function if exists public.fx_rate_to_eur(text, date);
