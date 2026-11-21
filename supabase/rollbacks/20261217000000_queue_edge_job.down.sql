-- Rollback of 20261217000000_queue_edge_job: categories and subscriptions after a first sync wait
-- for the 6-hourly cron again. The functions only log that the catch-up could not be queued.
drop function if exists public.queue_edge_job(text, int);
