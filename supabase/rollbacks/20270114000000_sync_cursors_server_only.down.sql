-- Rollback of 20270114000000_sync_cursors_server_only: Supabase's default grants come back. RLS
-- (on, no policy) still keeps anon and signed-in users out.
grant all on table public.sync_cursors to anon, authenticated;
