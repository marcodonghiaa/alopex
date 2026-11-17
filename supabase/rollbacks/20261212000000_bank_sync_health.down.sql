-- Rollback of 20261212000000_bank_sync_health: drop the columns, fan out to every bank account again.
create or replace function public.sync_all_banks() returns setof bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  base_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  secret_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'sync_bank_secret_key');
begin
  if base_url is null or secret_key is null then
    raise exception 'Set the Vault secrets project_url and sync_bank_secret_key first';
  end if;
  return query
    select net.http_post(
      url := rtrim(base_url, '/') || '/functions/v1/sync-bank',
      body := jsonb_build_object('account_uid', a.uid),
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', secret_key),
      timeout_milliseconds := 150000
    )
    from public.accounts a
    where not a.manual;
end;
$function$;

-- create or replace keeps the grants, but repeat the revoke so this file is safe on its own.
revoke execute on function public.sync_all_banks() from public, anon, authenticated, service_role;

-- The view as 20261130000000 left it, before the columns it reads go.
drop view public.v_bank_accounts_latest;
create view public.v_bank_accounts_latest with (security_invoker = true) as
 select distinct on (a.user_id, a.uid)
    a.user_id, a.uid, a.label, a.iban, a.currency, a.consent_valid_until,
    e.snapshot_date, e.amount, e.amount_eur, a.bank_name, a.bank_logo, a.bank_country,
    a.account_type, a.manual
   from public.accounts a
     left join public.v_net_worth_eur e on e.user_id = a.user_id and e.account_uid = a.uid
   where not a.manual or e.snapshot_date is not null
   order by a.user_id, a.uid, e.snapshot_date desc nulls last;
grant select on public.v_bank_accounts_latest to authenticated, service_role;

alter table public.accounts drop column if exists sync_error, drop column if exists sync_error_at, drop column if exists bank_session_id;
