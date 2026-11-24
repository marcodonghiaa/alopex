-- register_dashboard_origin as in 20261106000000_dashboard_origins, with a narrower Vercel deployment
-- rule. It refused any host with a 9-character dash-separated segment, which also hit real production
-- aliases such as <project>-<user>s-projects.vercel.app for an 8-letter user name, so the owner's
-- dashboard never reached CORS. A deployment hash mixes letters and digits; a name segment of only
-- letters (or only digits) is now accepted. Branch (-git-) hosts are still refused.
create or replace function public.register_dashboard_origin()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  owner_id uuid;
  hdr text;
begin
  select id into owner_id from auth.users order by created_at, id limit 1;
  if caller is null or owner_id is distinct from caller then return 'not_owner'; end if;

  hdr := lower(nullif(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'origin', ''));
  if hdr is null then return 'no_origin'; end if;

  if length(hdr) > 255
     or not (hdr ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' or hdr ~ '^http://localhost:[0-9]{1,5}$')
     or hdr ~ '-(?=[a-z]*[0-9])(?=[0-9]*[a-z])[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app(:[0-9]+)?$'
     or hdr ~ '-git-[a-z0-9-]+\.vercel\.app(:[0-9]+)?$' then
    return 'rejected';
  end if;

  if exists (select 1 from public.dashboard_origins where origin = hdr) then return 'exists'; end if;
  if (select count(*) from public.dashboard_origins) >= 5 then return 'full'; end if;
  insert into public.dashboard_origins (origin) values (hdr) on conflict do nothing;
  return 'added';
end;
$$;

revoke all on function public.register_dashboard_origin() from public, anon;
grant execute on function public.register_dashboard_origin() to authenticated;
