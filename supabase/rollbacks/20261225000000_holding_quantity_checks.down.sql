-- Holdings accept any quantity again, as before 20261225000000.
alter table public.portfolio_holdings drop constraint if exists portfolio_holdings_shares_ok;
alter table public.crypto_holdings drop constraint if exists crypto_holdings_amount_ok;
