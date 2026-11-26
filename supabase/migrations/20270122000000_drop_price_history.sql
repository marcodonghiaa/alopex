-- H266: drop price_history. Nothing has written it since backfill-price-history.js left the sync,
-- and nothing reads it since 20270107000000 (holding_performance uses only price snapshots).
-- Its read-all policy let every signed-in user list the symbols other users had backfilled.
-- Any old backfilled rows are deleted; returns do not change (they no longer read them).
drop table if exists public.price_history;
