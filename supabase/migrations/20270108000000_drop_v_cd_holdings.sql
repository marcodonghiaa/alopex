-- Deposits left the app in 20261130000000_account_types; nothing reads v_cd_holdings (the dashboard
-- and the functions never query it). The view holds no data of its own, so it goes. The
-- cd_holdings table and its rows stay: the data export still includes them. A later release drops
-- the table once the export no longer needs it.
drop view if exists public.v_cd_holdings;
comment on table public.cd_holdings is
  'Deprecated: deposits left the app in 20261130000000. Kept so no data is lost (it is in the data export); a later release drops it.';
