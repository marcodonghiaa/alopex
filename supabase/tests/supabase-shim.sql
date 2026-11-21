-- Just enough of Supabase for RLS tests on plain Postgres: the API roles, auth.users and an
-- auth.uid() that reads the JWT claims PostgREST sets, plus Supabase's default grants on new tables.
-- Roles are cluster-wide and test files run in parallel: two files can both see a role missing
-- and both create it, so the loser's error is ignored.
do $$
declare r text[];
begin
  foreach r slice 1 in array array[['anon', ''], ['authenticated', ''], ['service_role', ' bypassrls']] loop
    begin
      if not exists (select from pg_roles where rolname = r[1]) then
        execute format('create role %I nologin%s', r[1], r[2]);
      end if;
    exception when duplicate_object or unique_violation then null;
    end;
  end loop;
end $$;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
