-- Rollback of 20270111000000_sync_all_banks_uses_call_edge_function: sync_all_banks as in
-- 20261212000000_bank_sync_health (its own Vault and pg_net block).
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
    where not a.manual
      -- An ended consent stops syncing at once (sync-bank marks an early end as today); a renewal brings it back.
      and (a.consent_valid_until is null or a.consent_valid_until > now());
end;
$function$;
revoke execute on function public.sync_all_banks() from public, anon, authenticated, service_role;
