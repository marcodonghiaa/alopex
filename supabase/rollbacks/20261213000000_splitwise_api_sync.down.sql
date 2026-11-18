-- Rollback of 20261213000000_splitwise_api_sync. Stops the sync and removes the connections
-- (their API keys are deleted from Vault first) and the review list; links that lived only on the
-- list are undone (see below). Shares the sync already wrote stay as ordinary Splitwise shares
-- (they keep counting), without their Splitwise ids.
-- Balances from the API are deleted: import the group's file again to see them.
select cron.unschedule(jobname) from cron.job where jobname = 'sync-splitwise';

delete from public.splitwise_connections; -- the trigger deletes each Vault secret
drop table if exists public.splitwise_connections;
drop function if exists public.splitwise_attempt(uuid, text, int, interval);
drop table if exists public.splitwise_attempts;
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

-- Links made on the To link list that live only on its row (an expense I paid all for others,
-- several payers, a settle-up) are undone: without the list nothing could free them, and after a
-- re-apply the expense would wait on the list with its payment refused. The payment counts as it
-- did before linking, and the extra share of a several-payers expense goes. A link backed by a
-- share (that share keeps it) or made by a CSV import stays.
do $$
begin
  if to_regclass('public.splitwise_review') is null then return; end if;
  update public.transactions t
     set personal_amount = case when r.kind in ('paid_by_me', 'multi_payer') then null else t.personal_amount end,
         flow_type = case when r.kind in ('settle_out', 'settle_in') and t.flow_type = 'transfer' then null else t.flow_type end,
         flow_source = case when r.kind in ('settle_out', 'settle_in') and t.flow_type = 'transfer' then null else t.flow_source end,
         import_batch_id = null
    from public.splitwise_review r
   where r.status = 'linked' and not r.from_csv and r.linked_entry_reference is not null
     and t.user_id = r.user_id and t.account_uid = r.linked_account_uid
     and t.entry_reference = r.linked_entry_reference and t.import_batch_id is not null
     and not exists (select 1 from public.splitwise_expenses s
                      where s.user_id = r.user_id and s.splitwise_id = r.splitwise_id
                        and s.linked_entry_reference = r.linked_entry_reference);
  delete from public.splitwise_expenses s
   using public.splitwise_review r
   where r.status = 'linked' and not r.from_csv and r.kind in ('paid_by_me', 'multi_payer') and r.my_share > r.my_paid
     and s.user_id = r.user_id and s.splitwise_id = r.splitwise_id
     and s.fingerprint like 'sw:%' and s.linked_entry_reference is null;
end;
$$;
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
  drop column if exists splitwise_description,
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

-- apply_splitwise_corrections as it was (20261109000000_splitwise_corrections.sql).
create or replace function public.apply_splitwise_corrections(
  p_batch uuid, p_group text, p_add jsonb, p_edit jsonb, p_remove jsonb
) returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  uid uuid := auth.uid();
  n_added int;
  n_edited int;
  n_removed int;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if jsonb_array_length(p_add) > 5000 or jsonb_array_length(p_edit) > 5000
     or jsonb_array_length(p_remove) > 5000 then
    raise exception 'Too many rows';
  end if;

  -- A missing cost would null the personal amount and count the bank transaction in full.
  if exists (select 1 from jsonb_to_recordset(p_edit) as e(cost numeric, amount numeric)
              where e.cost is null or e.cost <= 0 or e.amount is null or e.amount > e.cost) then
    raise exception 'An edit has no valid cost.';
  end if;

  -- The bank goes first: it reads the links as they were reviewed.
  update transactions t
     set personal_amount = null, import_batch_id = null
    from jsonb_to_recordset(p_remove) as r(id uuid, old_fingerprint text)
    join splitwise_expenses s on s.id = r.id and s.fingerprint = r.old_fingerprint
   where s.user_id = uid and s.group_name = p_group
     and t.user_id = uid and t.account_uid = s.linked_account_uid
     and t.entry_reference = s.linked_entry_reference;

  delete from splitwise_expenses s
   using jsonb_to_recordset(p_remove) as r(id uuid, old_fingerprint text)
   where s.id = r.id and s.fingerprint = r.old_fingerprint
     and s.user_id = uid and s.group_name = p_group;
  get diagnostics n_removed = row_count;
  if n_removed <> jsonb_array_length(p_remove) then
    raise exception 'A stored expense changed since the review. Reload and try again.';
  end if;

  update transactions t
     set personal_amount = round(t.amount * e.amount / e.cost, 2)
    from jsonb_to_recordset(p_edit) as e(id uuid, old_fingerprint text, amount numeric, cost numeric)
    join splitwise_expenses s on s.id = e.id and s.fingerprint = e.old_fingerprint
   where s.user_id = uid and s.group_name = p_group
     and t.user_id = uid and t.account_uid = s.linked_account_uid
     and t.entry_reference = s.linked_entry_reference;

  update splitwise_expenses s
     set fingerprint = e.fingerprint,
         booking_date = e.booking_date,
         description = e.description,
         amount = e.amount,
         currency = e.currency
    from jsonb_to_recordset(p_edit) as e(id uuid, old_fingerprint text, fingerprint text,
         booking_date date, description text, amount numeric, currency text)
   where s.id = e.id and s.fingerprint = e.old_fingerprint
     and s.user_id = uid and s.group_name = p_group;
  get diagnostics n_edited = row_count;
  if n_edited <> jsonb_array_length(p_edit) then
    raise exception 'A stored expense changed since the review. Reload and try again.';
  end if;

  insert into splitwise_expenses (user_id, group_name, fingerprint, booking_date, description,
      category, amount, currency, batch_id)
    select uid, p_group, a.fingerprint, a.booking_date, a.description, a.category, a.amount,
           a.currency, p_batch
      from jsonb_to_recordset(p_add) as a(fingerprint text, booking_date date, description text,
           category text, amount numeric, currency text);
  get diagnostics n_added = row_count;

  return jsonb_build_object('added', n_added, 'edited', n_edited, 'removed', n_removed);
end;
$function$;

-- save_splitwise_balances as it was (20261123000000_splitwise_balances_basis.sql).
create or replace function public.save_splitwise_balances(p_group text, p_balances jsonb)
returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  uid uuid := auth.uid();
  n int;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if jsonb_array_length(p_balances) > 200 then raise exception 'Too many rows'; end if;

  delete from splitwise_balances where user_id = uid and group_name = p_group;

  insert into splitwise_balances (user_id, group_name, person, balance, currency, is_me, basis)
    select uid, p_group, b.person, b.balance, b.currency, coalesce(b.is_me, false),
           coalesce(b.basis, 'group')
      from jsonb_to_recordset(p_balances)
        as b(person text, balance numeric, currency text, is_me boolean, basis text);
  get diagnostics n = row_count;

  return jsonb_build_object('balances', n);
end;
$function$;
