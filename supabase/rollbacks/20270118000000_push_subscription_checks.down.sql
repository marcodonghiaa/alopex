-- Rollback of 20270118000000_push_subscription_checks: direct inserts take any endpoint and keys
-- again. Deleted subscriptions are not brought back.
alter table public.push_subscriptions drop constraint if exists push_subscriptions_valid;
