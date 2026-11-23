-- Bank sync times. Banks allow about 4 unattended reads a day per account (PSD2 RTS art. 36(5)):
-- a 5th answers ASPSP_RATE_LIMIT_EXCEEDED, so Alopex stays at 4 syncs a day. Instead of every 6 h
-- from midnight UTC (one run wasted at night), the 4 runs now sit in European waking hours:
-- 05:17, 11:17, 16:17, 21:17 UTC (06/12/17/22 CET, 07/13/18/23 CEST). The rest of the chain
-- follows each run: post-sync +15 min, prices +20, Splitwise +25, subscriptions +30.
-- cron.schedule replaces a job of the same name, so re-running is safe.
select cron.schedule('sync-banks', '17 5,11,16,21 * * *', 'select public.sync_all_banks()');
select cron.schedule('post-sync', '32 5,11,16,21 * * *', $$select public.call_edge_function('post-sync')$$);
select cron.schedule('sync-prices', '37 5,11,16,21 * * *', $$select public.call_edge_function('sync-prices')$$);
select cron.schedule('sync-splitwise', '42 5,11,16,21 * * *', $$select public.call_edge_function('sync-splitwise')$$);
select cron.schedule('detect-recurring', '47 5,11,16,21 * * *', $$select public.call_edge_function('detect-recurring')$$);
