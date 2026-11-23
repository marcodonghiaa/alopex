-- Users write their own holdings through RLS, and Postgres numeric accepts NaN and Infinity. One
-- holding with a NaN, infinite or huge quantity made the daily price sync fail for every user
-- (the sync now skips such a row too). New writes must be a real quantity: zero or more, under
-- 1e12. NaN sorts above every number in Postgres, so `< 1e12` also refuses NaN and Infinity.
-- NOT VALID: existing rows are not checked, so the migration never fails or changes anyone's data.
-- Such a row still has to be fixed (or deleted) before it can be updated.
alter table public.portfolio_holdings drop constraint if exists portfolio_holdings_shares_ok;
alter table public.portfolio_holdings add constraint portfolio_holdings_shares_ok
  check (shares >= 0 and shares < 1e12) not valid;

alter table public.crypto_holdings drop constraint if exists crypto_holdings_amount_ok;
alter table public.crypto_holdings add constraint crypto_holdings_amount_ok
  check (amount >= 0 and amount < 1e12) not valid;
