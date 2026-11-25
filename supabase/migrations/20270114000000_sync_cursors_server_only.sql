-- H268: sync_cursors is written only by the sync (service role) and has RLS on with no policy, so
-- nobody else can read it today. It still had Supabase's default grants to anon and authenticated,
-- so turning RLS off once (say while debugging) would have let anyone rewrite sync cursors. Revoke
-- them, as for the other server-only tables (bank_sessions, dashboard_origins, splitwise_attempts).
-- The dashboard never reads this table; deleting an account still removes its cursor (the foreign
-- key cascade runs as the table owner).
revoke all on table public.sync_cursors from anon, authenticated;
