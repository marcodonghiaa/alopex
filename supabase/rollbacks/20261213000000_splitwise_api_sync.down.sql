-- Rollback of 20261213000000_splitwise_api_sync. Stops the sync and removes the connections
-- (their API keys are deleted from Vault first) and the review list. Shares the sync already
-- wrote stay as ordinary Splitwise shares (they keep counting), without their Splitwise ids.
-- Balances from the API are deleted: import the group's file again to see them.
select cron.unschedule(jobname) from cron.job where jobname = 'sync-splitwise';

delete from public.splitwise_connections; -- the trigger deletes each Vault secret
drop table if exists public.splitwise_connections;
drop function if exists public.splitwise_connection_forget_key();
drop function if exists public.splitwise_save_connection(uuid, text, bigint, text);
drop function if exists public.splitwise_read_key(uuid);
drop function if exists public.get_splitwise_connection();
drop function if exists public.splitwise_sync_apply(uuid, jsonb, jsonb, bigint[], jsonb, timestamptz, boolean, boolean);
drop function if exists public.splitwise_sync_write(uuid, jsonb, jsonb, bigint[], jsonb, timestamptz, boolean);
drop function if exists public.splitwise_disconnect(uuid, boolean);
drop function if exists public.link_splitwise_review(uuid, uuid, text);
drop function if exists public.count_splitwise_review(uuid);
drop function if exists public.dismiss_splitwise_review(uuid);
drop function if exists public.reject_splitwise_match(uuid, text);
drop function if exists public.splitwise_release(uuid, bigint[]);
drop function if exists public.splitwise_csv_match(uuid, text, date, text, numeric, text);
drop table if exists public.splitwise_review;

delete from public.splitwise_balances where basis = 'api';
alter table public.splitwise_balances drop constraint if exists splitwise_balances_basis_check;
alter table public.splitwise_balances
  add constraint splitwise_balances_basis_check check (basis in ('group', 'pairwise'));
alter table public.splitwise_balances drop constraint if exists splitwise_balances_pkey;
alter table public.splitwise_balances add primary key (user_id, group_name, person);
drop index if exists public.splitwise_balances_one_me_idx;
create unique index splitwise_balances_one_me_idx on public.splitwise_balances (user_id, group_name) where is_me;

drop index if exists public.splitwise_expenses_splitwise_id;
alter table public.splitwise_expenses
  drop constraint if exists splitwise_expenses_source_check,
  drop column if exists splitwise_updated_at,
  drop column if exists source,
  drop column if exists splitwise_id;

-- import_splitwise as it was (20261031000000_splitwise_import_keeps_edits.sql).
create or replace function public.import_splitwise(
  p_batch uuid, p_group text, p_from date, p_to date, p_shares jsonb, p_links jsonb
) returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  uid uuid := auth.uid();
  n_shares int;
  n_links int;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if jsonb_array_length(p_shares) > 5000 or jsonb_array_length(p_links) > 5000 then
    raise exception 'Too many rows';
  end if;

  -- A share already stored (same fingerprint) is updated in place, so a description or category
  -- edited since the last import survives; a category still empty is filled from the file.
  insert into splitwise_expenses (user_id, group_name, fingerprint, booking_date, description,
      category, amount, currency, batch_id, linked_account_uid, linked_entry_reference)
    select uid, p_group, s.fingerprint, s.booking_date, s.description, s.category, s.amount,
           s.currency, p_batch, s.linked_account_uid, s.linked_entry_reference
      from jsonb_to_recordset(p_shares) as s(fingerprint text, booking_date date, description text,
           category text, amount numeric, currency text, linked_account_uid uuid,
           linked_entry_reference text)
    on conflict (user_id, group_name, fingerprint) do update
      set booking_date = excluded.booking_date,
          category = coalesce(splitwise_expenses.category, excluded.category),
          amount = excluded.amount,
          currency = excluded.currency,
          batch_id = excluded.batch_id,
          linked_account_uid = excluded.linked_account_uid,
          linked_entry_reference = excluded.linked_entry_reference;
  get diagnostics n_shares = row_count;

  delete from splitwise_expenses
   where user_id = uid and group_name = p_group and booking_date between p_from and p_to
     and batch_id is distinct from p_batch;

  update transactions t
     set personal_amount = case l.action when 'set_personal_amount' then l.personal_amount else t.personal_amount end,
         flow_type = case l.action when 'mark_transfer' then 'transfer' else t.flow_type end,
         import_batch_id = p_batch
    from jsonb_to_recordset(p_links) as l(account_uid uuid, entry_reference text, action text, personal_amount numeric)
   where t.user_id = uid and t.account_uid = l.account_uid and t.entry_reference = l.entry_reference
     and l.action in ('set_personal_amount', 'mark_transfer')
     and t.personal_amount is null and t.deleted_at is null
     and t.flow_type is distinct from 'transfer' and t.flow_type is distinct from 'refunded';
  get diagnostics n_links = row_count;
  if n_links <> jsonb_array_length(p_links) then
    raise exception 'A bank transaction changed since the review. Reload and try again.';
  end if;

  -- Links kept from an earlier import now belong to this one, so Undo covers them too.
  update transactions t set import_batch_id = p_batch
    from splitwise_expenses s
   where s.user_id = uid and s.batch_id = p_batch and s.linked_entry_reference is not null
     and t.user_id = uid and t.account_uid = s.linked_account_uid
     and t.entry_reference = s.linked_entry_reference
     and t.import_batch_id is distinct from p_batch;

  return jsonb_build_object('shares', n_shares, 'links', n_links);
end;
$function$;

-- undo_splitwise_import as it was (20261116000000_splitwise_undo_keeps_flow.sql).
create or replace function public.undo_splitwise_import(p_batch uuid) returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  uid uuid := auth.uid();
  n_shares int;
  n_links int;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  update transactions
     set personal_amount = null,
         flow_type = case when flow_type = 'transfer' then null else flow_type end,
         import_batch_id = null
   where user_id = uid and import_batch_id = p_batch;
  get diagnostics n_links = row_count;
  delete from splitwise_expenses where user_id = uid and batch_id = p_batch;
  get diagnostics n_shares = row_count;
  return jsonb_build_object('shares', n_shares, 'links', n_links);
end;
$function$;
