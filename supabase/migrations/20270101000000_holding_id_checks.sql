-- Users write their own holdings through RLS, with no limit on the symbol or id text. The daily
-- price sync puts every user's CoinGecko ids into shared requests, so one huge or malformed id
-- could break pricing for everyone (H048). New writes must look like a real ISIN, ticker or
-- CoinGecko id (the same rule add-holding already applies).
-- NOT VALID: existing rows are not checked, so the migration never fails or changes anyone's data.
alter table public.portfolio_holdings drop constraint if exists portfolio_holdings_ids_ok;
alter table public.portfolio_holdings add constraint portfolio_holdings_ids_ok
  check (char_length(isin) between 1 and 40 and char_length(yahoo_symbol) between 1 and 40) not valid;

alter table public.crypto_holdings drop constraint if exists crypto_holdings_ids_ok;
alter table public.crypto_holdings add constraint crypto_holdings_ids_ok
  check (char_length(asset_symbol) between 1 and 40 and coingecko_id ~ '^[a-z0-9._-]{1,100}$') not valid;
