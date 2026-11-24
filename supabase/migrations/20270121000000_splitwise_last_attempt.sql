-- H230: the Splitwise cron ordered connections by last_synced_at, which only a successful sync
-- sets. A run the platform killed for time never recorded anything, so that user stayed first on
-- every run, and if their sync always overran, nobody after them was ever synced. The cron now
-- stamps last_attempt_at before each user and orders by it (never tried first, then the oldest
-- try; last_synced_at breaks ties). Server-only like the rest of the table: no grant changes.
-- Existing rows start with null, so the first run keeps today's order.
alter table public.splitwise_connections add column if not exists last_attempt_at timestamptz;
