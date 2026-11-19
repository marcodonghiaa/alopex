-- Rollback of 20261216000000_splitwise_pro_required: a connection waiting on Splitwise Pro goes
-- back to needs_reconnect (the cron skips it the same way), then the old status check returns.
update public.splitwise_connections set status = 'needs_reconnect' where status = 'pro_required';
alter table public.splitwise_connections drop constraint if exists splitwise_connections_status_check;
alter table public.splitwise_connections add constraint splitwise_connections_status_check
  check (status in ('ok', 'needs_reconnect', 'error'));
