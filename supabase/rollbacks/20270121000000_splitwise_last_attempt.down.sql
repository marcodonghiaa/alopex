-- Rollback of 20270121000000_splitwise_last_attempt. Deploy the previous sync-splitwise first:
-- this release's function orders by the column and its cron run fails without it.
alter table public.splitwise_connections drop column if exists last_attempt_at;
