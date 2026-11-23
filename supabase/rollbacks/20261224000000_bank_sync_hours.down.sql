-- Back to every 6 h from midnight UTC, as before 20261224000000.
select cron.schedule('sync-banks', '17 */6 * * *', 'select public.sync_all_banks()');
select cron.schedule('post-sync', '32 */6 * * *', $$select public.call_edge_function('post-sync')$$);
select cron.schedule('sync-prices', '37 */6 * * *', $$select public.call_edge_function('sync-prices')$$);
select cron.schedule('sync-splitwise', '42 */6 * * *', $$select public.call_edge_function('sync-splitwise')$$);
select cron.schedule('detect-recurring', '47 */6 * * *', $$select public.call_edge_function('detect-recurring')$$);
