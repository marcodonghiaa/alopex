-- Users write their own holdings through RLS, and Postgres numeric accepts NaN and Infinity. One
-- holding with a NaN or infinite quantity made the daily price sync fail for every user (the sync
-- now also skips any holding it can't value). New writes must be a real quantity: zero or more and
-- finite. NaN sorts above every number in Postgres, Infinity included, so `< 'Infinity'` refuses
-- both. No upper bound: a meme coin can be held in the trillions.
-- NOT VALID: existing rows are not checked, so the migration never fails or changes anyone's data.
-- Such a row still has to be fixed (or deleted) before it can be updated.
alter table public.portfolio_holdings drop constraint if exists portfolio_holdings_shares_ok;
alter table public.portfolio_holdings add constraint portfolio_holdings_shares_ok
  check (shares >= 0 and shares < 'Infinity'::numeric) not valid;

alter table public.crypto_holdings drop constraint if exists crypto_holdings_amount_ok;
alter table public.crypto_holdings add constraint crypto_holdings_amount_ok
  check (amount >= 0 and amount < 'Infinity'::numeric) not valid;
