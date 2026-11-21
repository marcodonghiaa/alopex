-- After a bank's first sync, the Edge Functions queue the next step themselves: post-sync in
-- rounds until nothing is left, then detect-recurring (e2e test 2026-11-20 #7, #9, #13: a new
-- user saw everything Uncategorized and no subscriptions for up to 6 hours).
-- call_edge_function stays database-only (it carries the secret key); this wrapper lets the
-- service role start just these two jobs, through pg_net, so no function waits for another.
create or replace function public.queue_edge_job(job text, round int default 0)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if job = 'post-sync' and round between 1 and 10 then
    return public.call_edge_function('post-sync', jsonb_build_object('catch_up', round));
  elsif job = 'detect-recurring' then
    return public.call_edge_function('detect-recurring');
  end if;
  raise exception 'Not a job that can be queued: % (round %)', job, round;
end;
$function$;

revoke execute on function public.queue_edge_job(text, int) from public, anon, authenticated;
grant execute on function public.queue_edge_job(text, int) to service_role;
