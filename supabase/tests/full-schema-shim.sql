-- With supabase-shim.sql, enough of Supabase to apply every migration in order on plain Postgres
-- (no pg_net or pg_cron: tests strip those two `create extension` lines and use the stubs below).
-- Lets a test run on the real schema, with its triggers and views, instead of a hand-made copy.
-- Roles are cluster-wide and test files run in parallel: the loser of a create race ignores the error.
do $$ begin
  begin
    if not exists (select from pg_roles where rolname = 'authenticator') then create role authenticator noinherit login; end if;
  exception when duplicate_object or unique_violation then null;
  end;
  begin
    if not exists (select from pg_roles where rolname = 'supabase_admin') then create role supabase_admin; end if;
  exception when duplicate_object or unique_violation then null;
  end;
end $$;
alter table auth.users add column created_at timestamptz default now(), add column email text;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', current_user)
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}')
$$;
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid, status text, factor_type text);
create schema extensions;
create schema vault;
-- Vault without encryption: same table, view and functions the migrations call.
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text, secret text not null);
create view vault.decrypted_secrets as select id, name, description, secret, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
  returns uuid language sql as $$ insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null)
  returns void language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
    description = coalesce(new_description, description) where id = secret_id $$;
create schema cron;
create table cron.job (jobid bigserial, jobname text unique, schedule text, command text);
create function cron.schedule(text, text, text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values ($1, $2, $3)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create function cron.unschedule(text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = $1 returning 1) select exists (select 1 from d) $$;
create schema net;
create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 0)
  returns bigint language sql as $$ select 1::bigint $$;
