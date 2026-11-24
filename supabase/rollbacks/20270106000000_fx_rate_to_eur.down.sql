-- Rollback of 20270106000000_fx_rate_to_eur. Roll back anything that calls it first.
drop function if exists public.fx_rate_to_eur(text, date);
