-- Splitwise Pro: since 2026 Splitwise serves API keys only while the account that registered the
-- app has an active Splitwise Pro subscription. Each Alopex user registers their own key, so each
-- needs Pro (the CSV import works for everyone). When Splitwise says so (a 403 naming Pro), the
-- sync marks the connection pro_required: like needs_reconnect, the cron skips it until the user
-- connects again (splitwise_save_connection sets 'ok'), and the dashboard says what to do.
alter table public.splitwise_connections drop constraint if exists splitwise_connections_status_check;
alter table public.splitwise_connections add constraint splitwise_connections_status_check
  check (status in ('ok', 'needs_reconnect', 'error', 'pro_required'));
