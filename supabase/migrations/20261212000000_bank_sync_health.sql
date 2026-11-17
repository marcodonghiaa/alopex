-- Enable Banking review (2026-11-17):
-- 1. accounts.sync_error / sync_error_at: the last sync's failure (Enable Banking's error name, e.g.
--    ASPSP_RATE_LIMIT_EXCEEDED, or HTTP_<status> / TIMEOUT / NETWORK / SAVE_FAILED) and when it was
--    first seen, so the dashboard can say why an account stopped updating. Cleared by the next good run.
-- 2. accounts.bank_session_id: the Enable Banking session the account reads from, so a renewal can
--    close the session it replaced. Null for accounts linked before this column (never closed).
-- 3. sync_all_banks skips accounts whose consent has ended: the bank refuses them anyway, and each
--    call logged a 502 every six hours. A renewal moves consent_valid_until and brings them back.
alter table public.accounts
  add column if not exists sync_error text,
  add column if not exists sync_error_at timestamptz,
  add column if not exists bank_session_id text;

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
      -- Ended today still syncs: sync-bank marks an early end as today, the day it saw it.
      and (a.consent_valid_until is null or a.consent_valid_until >= date_trunc('day', now()));
end;
$function$;

-- create or replace keeps the grants, but repeat the revoke so this file is safe on its own.
revoke execute on function public.sync_all_banks() from public, anon, authenticated, service_role;

-- The Accounts page reads the bank accounts from this view: same as 20261130000000, plus the
-- sync error (create or replace may only add columns at the end).
create or replace view public.v_bank_accounts_latest with (security_invoker = true) as
 select distinct on (a.user_id, a.uid)
    a.user_id, a.uid, a.label, a.iban, a.currency, a.consent_valid_until,
    e.snapshot_date, e.amount, e.amount_eur, a.bank_name, a.bank_logo, a.bank_country,
    a.account_type, a.manual, a.sync_error, a.sync_error_at
   from public.accounts a
     left join public.v_net_worth_eur e on e.user_id = a.user_id and e.account_uid = a.uid
   where not a.manual or e.snapshot_date is not null
   order by a.user_id, a.uid, e.snapshot_date desc nulls last;
