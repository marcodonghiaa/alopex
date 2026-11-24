-- sync_all_banks as in 20261212000000_bank_sync_health, but each account goes through
-- call_edge_function (20261118000000_schedule_sync) instead of a copy of its Vault, header and
-- timeout block, so a change there reaches the bank sync too. Same accounts, same calls; the
-- secrets are read once per account. With no bank account it no longer checks the secrets.
create or replace function public.sync_all_banks() returns setof bigint
language sql
security definer
set search_path = ''
as $function$
  select public.call_edge_function('sync-bank', jsonb_build_object('account_uid', a.uid))
  from public.accounts a
  where not a.manual
    -- An ended consent stops syncing at once (sync-bank marks an early end as today); a renewal brings it back.
    and (a.consent_valid_until is null or a.consent_valid_until > now());
$function$;

-- create or replace keeps the grants, but repeat the revoke so this file is safe on its own.
revoke execute on function public.sync_all_banks() from public, anon, authenticated, service_role;
