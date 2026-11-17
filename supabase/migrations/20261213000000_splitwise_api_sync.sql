-- Splitwise sync through the Splitwise API, every 6 hours, with each user's own personal API key.
--   * splitwise_connections: one row per connected user. Server-only (RLS on, no policy): the key
--     itself is a Supabase Vault secret (key_secret_id), never a readable column. The dashboard
--     reads its own status through get_splitwise_connection().
--   * splitwise_expenses gets splitwise_id (the Splitwise expense id), source ('csv' or 'api') and
--     splitwise_updated_at. A synced share's fingerprint is 'sw:<id>'. A share from the CSV import
--     with the same date (±1 day), description, amount and currency is adopted (it gets the id)
--     instead of being imported twice.
--   * splitwise_review: expenses the sync can't decide alone (I paid, several payers, settle-ups).
--     Written by the sync only; the owner links, counts, dismisses or rejects matches with the
--     RPCs below. Settled rows stay settled unless the expense's amounts change in Splitwise.
--   * splitwise_balances: basis 'api' (what Splitwise's API says), one row per currency.
--   * splitwise_sync_apply: the one write of a sync run (service role only).
--   * pg_cron job sync-splitwise at 42 */6 (UTC).
-- Needs the Vault extension (every Supabase project has it).

-- ---- Connections ----

create table public.splitwise_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  splitwise_user_id bigint not null,
  display_name text check (display_name is null or char_length(display_name) <= 200),
  key_secret_id uuid,
  status text not null default 'ok' check (status in ('ok', 'needs_reconnect', 'error')),
  last_error text check (last_error is null or char_length(last_error) <= 200),
  cursor_updated_at timestamptz,
  last_full_check_at timestamptz,
  last_synced_at timestamptz,
  consent_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.splitwise_connections enable row level security;
revoke all on table public.splitwise_connections from anon, authenticated;

-- A deleted connection (disconnect, or the user's account deleted: the row cascades) takes its
-- Vault secret with it, so no API key outlives its user.
create or replace function public.splitwise_connection_forget_key() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.key_secret_id is not null then
    delete from vault.secrets where id = old.key_secret_id;
  end if;
  return old;
end;
$$;
revoke execute on function public.splitwise_connection_forget_key() from public, anon, authenticated, service_role;
drop trigger if exists trg_splitwise_connection_forget_key on public.splitwise_connections;
create trigger trg_splitwise_connection_forget_key
  after delete on public.splitwise_connections
  for each row execute function public.splitwise_connection_forget_key();

-- Saves (or replaces) the user's API key in Vault and records the connection with the consent
-- time. Connecting another Splitwise account restarts the sync from scratch (cursor cleared).
create or replace function public.splitwise_save_connection(
  p_user uuid, p_key text, p_splitwise_user_id bigint, p_display_name text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
  v_name text := 'splitwise_api_key:' || p_user::text;
begin
  if p_user is null or p_splitwise_user_id is null then raise exception 'Missing user'; end if;
  if p_key is null or char_length(p_key) not between 1 and 500 then raise exception 'Missing API key'; end if;
  select key_secret_id into v_secret from public.splitwise_connections where user_id = p_user for update;
  if v_secret is not null and exists (select 1 from vault.secrets where id = v_secret) then
    perform vault.update_secret(v_secret, p_key);
  else
    delete from vault.secrets where name = v_name;
    v_secret := vault.create_secret(p_key, v_name, 'Splitwise API key, read only by the sync-splitwise Edge Function');
  end if;
  insert into public.splitwise_connections (user_id, splitwise_user_id, display_name, key_secret_id, status, consent_at)
  values (p_user, p_splitwise_user_id, left(p_display_name, 200), v_secret, 'ok', now())
  on conflict (user_id) do update
    set cursor_updated_at = case when splitwise_connections.splitwise_user_id = excluded.splitwise_user_id
                                 then splitwise_connections.cursor_updated_at end,
        last_full_check_at = case when splitwise_connections.splitwise_user_id = excluded.splitwise_user_id
                                  then splitwise_connections.last_full_check_at end,
        splitwise_user_id = excluded.splitwise_user_id,
        display_name = excluded.display_name,
        key_secret_id = excluded.key_secret_id,
        status = 'ok',
        last_error = null,
        consent_at = excluded.consent_at;
end;
$$;

-- The decrypted key, for the sync only.
create or replace function public.splitwise_read_key(p_user uuid) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret
    from public.splitwise_connections c
    join vault.decrypted_secrets s on s.id = c.key_secret_id
   where c.user_id = p_user;
$$;

-- What the dashboard may know about its own connection: never the key.
create or replace function public.get_splitwise_connection()
returns table (connected boolean, status text, display_name text, last_synced_at timestamptz, last_error text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.user_id is not null, c.status, c.display_name, c.last_synced_at, c.last_error
    from (select auth.uid() as uid) me
    left join public.splitwise_connections c on c.user_id = me.uid;
$$;

-- ---- Shares from the API ----

alter table public.splitwise_expenses
  add column if not exists splitwise_id bigint,
  add column if not exists source text not null default 'csv',
  add column if not exists splitwise_updated_at timestamptz;
alter table public.splitwise_expenses drop constraint if exists splitwise_expenses_source_check;
alter table public.splitwise_expenses add constraint splitwise_expenses_source_check check (source in ('csv', 'api'));
create unique index if not exists splitwise_expenses_splitwise_id
  on public.splitwise_expenses (user_id, splitwise_id) where splitwise_id is not null;

-- ---- Review list ----

create table public.splitwise_review (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  splitwise_id bigint not null,
  kind text not null check (kind in ('paid_by_me', 'multi_payer', 'settle_out', 'settle_in')),
  group_name text not null check (char_length(group_name) between 1 and 100),
  booking_date date not null,
  description text not null check (char_length(description) <= 300),
  cost numeric not null check (cost >= 0 and cost < 1000000000),
  my_share numeric not null check (my_share >= 0 and my_share < 1000000000),
  my_paid numeric not null check (my_paid >= 0 and my_paid < 1000000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  splitwise_updated_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'dismissed', 'linked', 'counted')),
  rejected_entry_references text[] not null default '{}' check (cardinality(rejected_entry_references) <= 200),
  linked_account_uid uuid,
  linked_entry_reference text,
  created_at timestamptz not null default now(),
  unique (user_id, splitwise_id),
  check ((linked_account_uid is null) = (linked_entry_reference is null))
);
alter table public.splitwise_review enable row level security;
revoke all on table public.splitwise_review from anon, authenticated;
grant select, update, delete on table public.splitwise_review to authenticated;
create policy "Users can view own splitwise review" on public.splitwise_review
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can update own splitwise review" on public.splitwise_review
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own splitwise review" on public.splitwise_review
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ---- Balances ----

-- 'api': as the Splitwise API reports them, per currency (my row: what the group owes me; anyone
-- else's: what I owe them, negative when they owe me, like 'pairwise').
alter table public.splitwise_balances drop constraint if exists splitwise_balances_basis_check;
alter table public.splitwise_balances
  add constraint splitwise_balances_basis_check check (basis in ('group', 'pairwise', 'api'));
-- One row per currency: a Splitwise group can hold debts in several.
alter table public.splitwise_balances drop constraint if exists splitwise_balances_pkey;
alter table public.splitwise_balances add primary key (user_id, group_name, person, currency);
drop index if exists public.splitwise_balances_one_me_idx;
create unique index splitwise_balances_one_me_idx on public.splitwise_balances (user_id, group_name, currency)
  where is_me;

-- ---- The CSV import leaves synced rows alone ----

-- Same as 20261031000000, except the range clean-up skips rows that came from the API (or were
-- adopted by it): re-importing a group's file must not delete what the sync wrote.
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
     and batch_id is distinct from p_batch and splitwise_id is null;

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

  update transactions t set import_batch_id = p_batch
    from splitwise_expenses s
   where s.user_id = uid and s.batch_id = p_batch and s.linked_entry_reference is not null
     and t.user_id = uid and t.account_uid = s.linked_account_uid
     and t.entry_reference = s.linked_entry_reference
     and t.import_batch_id is distinct from p_batch;

  return jsonb_build_object('shares', n_shares, 'links', n_links);
end;
$function$;

-- ---- Shared steps ----

-- Frees what Alopex did for these Splitwise expenses and removes their shares: a bank payment's
-- personal amount set from a share goes back to null, a settle-up marked as transfer counts by
-- its direction again (same as undo_splitwise_import), and review rows lose their link (their
-- status is the caller's business). Only rows an import or link changed (import_batch_id set).
-- Runs as the caller: with a user's JWT, row level security keeps it to their own rows.
create or replace function public.splitwise_release(p_user uuid, p_ids bigint[]) returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  update public.transactions t
     set personal_amount = null, import_batch_id = null
    from public.splitwise_expenses s
   where s.user_id = p_user and s.splitwise_id = any(p_ids) and s.linked_entry_reference is not null
     and t.user_id = p_user and t.account_uid = s.linked_account_uid
     and t.entry_reference = s.linked_entry_reference and t.import_batch_id is not null;
  -- Through the review row too: a payment linked to an expense I paid all for others has no
  -- share row (my share is 0), and a settle-up never has one.
  update public.transactions t
     set personal_amount = case when r.kind in ('paid_by_me', 'multi_payer') then null else t.personal_amount end,
         flow_type = case when r.kind in ('settle_out', 'settle_in') and t.flow_type = 'transfer' then null else t.flow_type end,
         flow_source = case when r.kind in ('settle_out', 'settle_in') and t.flow_type = 'transfer' then null else t.flow_source end,
         import_batch_id = null
    from public.splitwise_review r
   where r.user_id = p_user and r.splitwise_id = any(p_ids)
     and r.status = 'linked' and r.linked_entry_reference is not null
     and t.user_id = p_user and t.account_uid = r.linked_account_uid
     and t.entry_reference = r.linked_entry_reference and t.import_batch_id is not null;
  delete from public.splitwise_expenses where user_id = p_user and splitwise_id = any(p_ids);
  update public.splitwise_review set linked_account_uid = null, linked_entry_reference = null
   where user_id = p_user and splitwise_id = any(p_ids) and linked_entry_reference is not null;
end;
$$;

-- A CSV-imported share the API expense is: same date (±1 day), description (case and outer
-- spaces aside), amount and currency, not yet adopted. Same group name first.
create or replace function public.splitwise_csv_match(
  p_user uuid, p_group text, p_date date, p_description text, p_amount numeric, p_currency text
) returns uuid
language sql
stable
set search_path = ''
as $$
  select c.id from public.splitwise_expenses c
   where c.user_id = p_user and c.splitwise_id is null and c.source = 'csv'
     and c.booking_date between p_date - 1 and p_date + 1
     and lower(btrim(c.description)) = lower(btrim(p_description))
     and c.amount = p_amount and c.currency = p_currency
   order by lower(btrim(c.group_name)) = lower(btrim(p_group)) desc, abs(c.booking_date - p_date), c.created_at, c.id
   limit 1;
$$;

-- ---- The sync's write ----

-- p_shares items: {splitwise_id, group_name, booking_date, description, category, amount, currency, splitwise_updated_at}
-- p_review items: {splitwise_id, kind, group_name, booking_date, description, cost, my_share, my_paid, currency, splitwise_updated_at}
-- p_deleted: ids deleted in Splitwise, no longer mine, or gone (full check).
-- p_balances items: {group_name, person, balance, currency, is_me}; null leaves balances alone.
-- p_cursor: newest updated_at seen (null: keep). p_full: this run read every expense.
create or replace function public.splitwise_sync_write(
  p_user uuid, p_shares jsonb, p_review jsonb, p_deleted bigint[], p_balances jsonb, p_cursor timestamptz, p_full boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch uuid := gen_random_uuid();
  v_ids bigint[];
  v_match uuid;
  v_acc uuid;
  v_ref text;
  n_new int := 0;
  n_adopted int := 0;
  n_review int := 0;
  n_deleted int := 0;
  r record;
begin
  -- Deleted in Splitwise, or no longer an expense of mine.
  select count(*) into n_deleted from (
    select splitwise_id from public.splitwise_expenses where user_id = p_user and splitwise_id = any(p_deleted)
    union
    select splitwise_id from public.splitwise_review where user_id = p_user and splitwise_id = any(p_deleted)
  ) d;
  perform public.splitwise_release(p_user, p_deleted);
  delete from public.splitwise_review where user_id = p_user and splitwise_id = any(p_deleted);

  -- Was on the review list, is now a share (someone else paid): the review row and its link go.
  select array_agg(rv.splitwise_id) into v_ids from public.splitwise_review rv
   where rv.user_id = p_user
     and rv.splitwise_id in (select (x ->> 'splitwise_id')::bigint from jsonb_array_elements(coalesce(p_shares, '[]')) x);
  perform public.splitwise_release(p_user, v_ids);
  delete from public.splitwise_review where user_id = p_user and splitwise_id = any(v_ids);

  -- Was a plain share, now needs review (I paid): the share goes.
  select array_agg(e.splitwise_id) into v_ids from public.splitwise_expenses e
   where e.user_id = p_user
     and e.splitwise_id in (select (x ->> 'splitwise_id')::bigint from jsonb_array_elements(coalesce(p_review, '[]')) x)
     and not exists (select 1 from public.splitwise_review rv
                      where rv.user_id = p_user and rv.splitwise_id = e.splitwise_id and rv.status in ('linked', 'counted'));
  perform public.splitwise_release(p_user, v_ids);

  -- Linked or counted, but its amounts changed in Splitwise: freed, and back to pending below.
  select array_agg(rv.splitwise_id) into v_ids
    from public.splitwise_review rv
    join jsonb_to_recordset(coalesce(p_review, '[]')) as x(splitwise_id bigint, kind text, cost numeric,
         my_share numeric, my_paid numeric, currency text) on x.splitwise_id = rv.splitwise_id
   where rv.user_id = p_user and rv.status in ('linked', 'counted')
     and (rv.kind, rv.cost, rv.my_share, rv.my_paid, rv.currency) is distinct from (x.kind, x.cost, x.my_share, x.my_paid, x.currency);
  perform public.splitwise_release(p_user, v_ids);

  -- First time this expense is seen: adopt the same share from a CSV import instead of doubling it.
  for r in
    select distinct on (x.splitwise_id) x.* from jsonb_to_recordset(coalesce(p_shares, '[]'))
      as x(splitwise_id bigint, group_name text, booking_date date, description text, amount numeric, currency text)
     where not exists (select 1 from public.splitwise_expenses e where e.user_id = p_user and e.splitwise_id = x.splitwise_id)
  loop
    v_match := public.splitwise_csv_match(p_user, r.group_name, r.booking_date, r.description, r.amount, r.currency);
    if v_match is not null then
      update public.splitwise_expenses set splitwise_id = r.splitwise_id, source = 'api' where id = v_match;
      n_adopted := n_adopted + 1;
    end if;
  end loop;

  -- Shares: Splitwise owns date, amount and currency; the description, category and bank link
  -- you have stay as they are.
  with up as (
    insert into public.splitwise_expenses (user_id, group_name, fingerprint, booking_date, description, category,
        amount, currency, batch_id, splitwise_id, source, splitwise_updated_at)
      select distinct on (x.splitwise_id) p_user, x.group_name, 'sw:' || x.splitwise_id, x.booking_date, x.description,
             x.category, x.amount, x.currency, v_batch, x.splitwise_id, 'api', x.splitwise_updated_at
        from jsonb_to_recordset(coalesce(p_shares, '[]')) as x(splitwise_id bigint, group_name text, booking_date date,
             description text, category text, amount numeric, currency text, splitwise_updated_at timestamptz)
    on conflict (user_id, splitwise_id) where splitwise_id is not null do update
      set booking_date = excluded.booking_date,
          category = coalesce(splitwise_expenses.category, excluded.category),
          amount = excluded.amount,
          currency = excluded.currency,
          source = 'api',
          splitwise_updated_at = excluded.splitwise_updated_at
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into n_new from up;

  -- An expense I paid that the CSV import already linked or counted: adopted, and settled.
  for r in
    select distinct on (x.splitwise_id) x.* from jsonb_to_recordset(coalesce(p_review, '[]'))
      as x(splitwise_id bigint, kind text, group_name text, booking_date date, description text, cost numeric,
           my_share numeric, my_paid numeric, currency text, splitwise_updated_at timestamptz)
     where x.kind in ('paid_by_me', 'multi_payer') and x.my_share > 0
       and not exists (select 1 from public.splitwise_review rv where rv.user_id = p_user and rv.splitwise_id = x.splitwise_id)
       and not exists (select 1 from public.splitwise_expenses e where e.user_id = p_user and e.splitwise_id = x.splitwise_id)
  loop
    v_match := public.splitwise_csv_match(p_user, r.group_name, r.booking_date, r.description, r.my_share, r.currency);
    if v_match is not null then
      update public.splitwise_expenses set splitwise_id = r.splitwise_id, source = 'api' where id = v_match
        returning linked_account_uid, linked_entry_reference into v_acc, v_ref;
      insert into public.splitwise_review (user_id, splitwise_id, kind, group_name, booking_date, description, cost,
          my_share, my_paid, currency, splitwise_updated_at, status, linked_account_uid, linked_entry_reference)
        values (p_user, r.splitwise_id, r.kind, r.group_name, r.booking_date, r.description, r.cost, r.my_share,
                r.my_paid, r.currency, r.splitwise_updated_at, case when v_ref is null then 'counted' else 'linked' end,
                v_acc, v_ref);
      n_adopted := n_adopted + 1;
    end if;
  end loop;

  -- Review rows: a row you dismissed, linked or counted keeps its status unless its amounts changed.
  with up as (
    insert into public.splitwise_review (user_id, splitwise_id, kind, group_name, booking_date, description, cost,
        my_share, my_paid, currency, splitwise_updated_at)
      select distinct on (x.splitwise_id) p_user, x.splitwise_id, x.kind, x.group_name, x.booking_date, x.description,
             x.cost, x.my_share, x.my_paid, x.currency, x.splitwise_updated_at
        from jsonb_to_recordset(coalesce(p_review, '[]')) as x(splitwise_id bigint, kind text, group_name text,
             booking_date date, description text, cost numeric, my_share numeric, my_paid numeric, currency text,
             splitwise_updated_at timestamptz)
    on conflict (user_id, splitwise_id) do update
      set status = case
            when (splitwise_review.kind, splitwise_review.cost, splitwise_review.my_share, splitwise_review.my_paid, splitwise_review.currency)
                 is distinct from (excluded.kind, excluded.cost, excluded.my_share, excluded.my_paid, excluded.currency)
            then 'pending' else splitwise_review.status end,
          kind = excluded.kind,
          group_name = excluded.group_name,
          booking_date = excluded.booking_date,
          description = excluded.description,
          cost = excluded.cost,
          my_share = excluded.my_share,
          my_paid = excluded.my_paid,
          currency = excluded.currency,
          splitwise_updated_at = excluded.splitwise_updated_at
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into n_review from up;

  -- Balances: the API's replace any earlier ones of the same group (from a CSV import too).
  if p_balances is not null then
    delete from public.splitwise_balances b
     where b.user_id = p_user
       and (b.basis = 'api' or b.group_name in (select x.group_name from jsonb_to_recordset(p_balances) as x(group_name text)));
    insert into public.splitwise_balances (user_id, group_name, person, balance, currency, is_me, basis)
      select p_user, x.group_name, x.person, x.balance, x.currency, coalesce(x.is_me, false), 'api'
        from jsonb_to_recordset(p_balances) as x(group_name text, person text, balance numeric, currency text, is_me boolean);
  end if;

  update public.splitwise_connections
     set last_synced_at = now(),
         status = 'ok',
         last_error = null,
         cursor_updated_at = greatest(cursor_updated_at, p_cursor),
         last_full_check_at = case when p_full then now() else last_full_check_at end
   where user_id = p_user;

  return jsonb_build_object('new', n_new, 'adopted', n_adopted, 'review', n_review, 'deleted', n_deleted);
end;
$$;

-- The one call a sync run makes per user (in chunks for big accounts). p_preview: do it all and
-- roll it back, returning the counts only (the dashboard's dry run).
create or replace function public.splitwise_sync_apply(
  p_user uuid, p_shares jsonb, p_review jsonb, p_deleted bigint[], p_balances jsonb, p_cursor timestamptz,
  p_full boolean, p_preview boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  res jsonb;
begin
  if p_user is null then raise exception 'Missing user'; end if;
  if coalesce(jsonb_array_length(p_shares), 0) > 5000 or coalesce(jsonb_array_length(p_review), 0) > 5000
     or coalesce(cardinality(p_deleted), 0) > 5000 or coalesce(jsonb_array_length(p_balances), 0) > 5000 then
    raise exception 'Too many rows';
  end if;
  -- One sync per user at a time (cron and "Sync now" can meet).
  perform 1 from public.splitwise_connections where user_id = p_user for update;
  if not found then raise exception 'Splitwise is not connected'; end if;
  if not coalesce(p_preview, false) then
    return public.splitwise_sync_write(p_user, p_shares, p_review, p_deleted, p_balances, p_cursor, coalesce(p_full, false));
  end if;
  begin
    res := public.splitwise_sync_write(p_user, p_shares, p_review, p_deleted, p_balances, p_cursor, coalesce(p_full, false));
    raise exception 'splitwise preview';
  exception when raise_exception then
    if sqlerrm <> 'splitwise preview' then raise; end if;
  end;
  return res;
end;
$$;

-- Disconnect: the key and the connection go. p_delete_data also removes everything the sync
-- brought in (shares, review list, API balances), freeing the bank payments it changed.
create or replace function public.splitwise_disconnect(p_user uuid, p_delete_data boolean) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids bigint[];
begin
  if p_user is null then raise exception 'Missing user'; end if;
  if p_delete_data then
    select array_agg(distinct i) into v_ids from (
      select splitwise_id as i from public.splitwise_expenses where user_id = p_user and splitwise_id is not null
      union all
      select splitwise_id from public.splitwise_review where user_id = p_user
    ) a;
    perform public.splitwise_release(p_user, v_ids);
    delete from public.splitwise_review where user_id = p_user;
    delete from public.splitwise_balances where user_id = p_user and basis = 'api';
  end if;
  delete from public.splitwise_connections where user_id = p_user;
  return jsonb_build_object('deleted', coalesce(cardinality(v_ids), 0));
end;
$$;

-- ---- The owner's review actions (as the caller, so row level security applies) ----

-- Links an expense to the bank payment it is: for one I paid, the payment counts only my share
-- (personal amount = payment × my share / what I paid, like the CSV import's links); for a
-- settle-up, the payment becomes a transfer.
create or replace function public.link_splitwise_review(p_id uuid, p_account_uid uuid, p_entry_reference text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  r splitwise_review;
  v_batch uuid := gen_random_uuid();
  n int;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  select * into r from splitwise_review where id = p_id and user_id = uid for update;
  if not found then raise exception 'This Splitwise expense is no longer on the list.'; end if;
  if r.status not in ('pending', 'dismissed') then raise exception 'This Splitwise expense is already settled.'; end if;
  if p_entry_reference = any(r.rejected_entry_references) then
    raise exception 'You said this bank transaction is not this expense.';
  end if;
  if r.kind in ('paid_by_me', 'multi_payer') then
    if r.my_paid <= 0 then raise exception 'Nothing paid to link.'; end if;
    update transactions t
       set personal_amount = least(t.amount, round(t.amount * r.my_share / r.my_paid, 2)), import_batch_id = v_batch
     where t.user_id = uid and t.account_uid = p_account_uid and t.entry_reference = p_entry_reference
       and t.credit_debit_indicator = 'DBIT' and t.personal_amount is null and t.deleted_at is null
       and t.flow_type is distinct from 'transfer' and t.flow_type is distinct from 'refunded';
  else
    update transactions t
       set flow_type = 'transfer', import_batch_id = v_batch
     where t.user_id = uid and t.account_uid = p_account_uid and t.entry_reference = p_entry_reference
       and t.credit_debit_indicator = case r.kind when 'settle_out' then 'DBIT' else 'CRDT' end
       and t.personal_amount is null and t.deleted_at is null
       and t.flow_type is distinct from 'transfer' and t.flow_type is distinct from 'refunded';
  end if;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'This bank transaction can no longer be linked. Reload and try again.'; end if;
  if r.kind in ('paid_by_me', 'multi_payer') and r.my_share > 0 then
    insert into splitwise_expenses (user_id, group_name, fingerprint, booking_date, description, amount, currency,
        batch_id, splitwise_id, source, splitwise_updated_at, linked_account_uid, linked_entry_reference)
      values (uid, r.group_name, 'sw:' || r.splitwise_id, r.booking_date, r.description, r.my_share, r.currency,
              v_batch, r.splitwise_id, 'api', r.splitwise_updated_at, p_account_uid, p_entry_reference)
    on conflict (user_id, splitwise_id) where splitwise_id is not null do update
      set amount = excluded.amount, batch_id = excluded.batch_id,
          linked_account_uid = excluded.linked_account_uid, linked_entry_reference = excluded.linked_entry_reference;
  end if;
  update splitwise_review
     set status = 'linked', linked_account_uid = p_account_uid, linked_entry_reference = p_entry_reference
   where id = p_id;
  return jsonb_build_object('status', 'linked');
end;
$$;

-- An expense I paid outside the banks Alopex sees (cash, another card): my share counts as spending.
create or replace function public.count_splitwise_review(p_id uuid) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  r splitwise_review;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  select * into r from splitwise_review where id = p_id and user_id = uid for update;
  if not found then raise exception 'This Splitwise expense is no longer on the list.'; end if;
  if r.kind not in ('paid_by_me', 'multi_payer') then
    raise exception 'Only an expense you paid can be counted without a bank payment.';
  end if;
  if r.status not in ('pending', 'dismissed') then raise exception 'This Splitwise expense is already settled.'; end if;
  if r.my_share > 0 then
    insert into splitwise_expenses (user_id, group_name, fingerprint, booking_date, description, amount, currency,
        batch_id, splitwise_id, source, splitwise_updated_at)
      values (uid, r.group_name, 'sw:' || r.splitwise_id, r.booking_date, r.description, r.my_share, r.currency,
              gen_random_uuid(), r.splitwise_id, 'api', r.splitwise_updated_at)
    on conflict (user_id, splitwise_id) where splitwise_id is not null do update
      set amount = excluded.amount, linked_account_uid = null, linked_entry_reference = null;
  end if;
  update splitwise_review set status = 'counted' where id = p_id;
  return jsonb_build_object('status', 'counted');
end;
$$;

-- Off the list. A linked or counted row is undone first (bank payment freed, share removed).
create or replace function public.dismiss_splitwise_review(p_id uuid) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  r splitwise_review;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  select * into r from splitwise_review where id = p_id and user_id = uid for update;
  if not found then raise exception 'This Splitwise expense is no longer on the list.'; end if;
  if r.status in ('linked', 'counted') then
    perform splitwise_release(uid, array[r.splitwise_id]);
  end if;
  update splitwise_review set status = 'dismissed', linked_account_uid = null, linked_entry_reference = null
   where id = p_id;
  return jsonb_build_object('status', 'dismissed');
end;
$$;

-- "Not this one": the bank transaction is never suggested for this expense again.
create or replace function public.reject_splitwise_match(p_id uuid, p_entry_reference text) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  n int;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if p_entry_reference is null or char_length(p_entry_reference) not between 1 and 500 then
    raise exception 'Missing bank transaction';
  end if;
  update splitwise_review
     set rejected_entry_references = rejected_entry_references || p_entry_reference
   where id = p_id and user_id = uid and not (p_entry_reference = any(rejected_entry_references));
  get diagnostics n = row_count;
  if n = 0 and not exists (select 1 from splitwise_review where id = p_id and user_id = uid) then
    raise exception 'This Splitwise expense is no longer on the list.';
  end if;
  return jsonb_build_object('rejected', n);
end;
$$;

-- ---- Who may call what ----

revoke execute on function public.splitwise_save_connection(uuid, text, bigint, text) from public, anon, authenticated;
revoke execute on function public.splitwise_read_key(uuid) from public, anon, authenticated;
revoke execute on function public.splitwise_disconnect(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.splitwise_sync_apply(uuid, jsonb, jsonb, bigint[], jsonb, timestamptz, boolean, boolean) from public, anon, authenticated;
grant execute on function public.splitwise_save_connection(uuid, text, bigint, text) to service_role;
grant execute on function public.splitwise_read_key(uuid) to service_role;
grant execute on function public.splitwise_disconnect(uuid, boolean) to service_role;
grant execute on function public.splitwise_sync_apply(uuid, jsonb, jsonb, bigint[], jsonb, timestamptz, boolean, boolean) to service_role;
-- Internal steps: only the functions above (running as their owner) call them.
revoke execute on function public.splitwise_sync_write(uuid, jsonb, jsonb, bigint[], jsonb, timestamptz, boolean) from public, anon, authenticated, service_role;
revoke execute on function public.splitwise_csv_match(uuid, text, date, text, numeric, text) from public, anon, authenticated, service_role;
-- Runs as the caller (row level security): dismiss_splitwise_review needs it with the user's JWT.
revoke execute on function public.splitwise_release(uuid, bigint[]) from public, anon;
grant execute on function public.splitwise_release(uuid, bigint[]) to authenticated, service_role;

revoke execute on function public.get_splitwise_connection() from public, anon;
revoke execute on function public.link_splitwise_review(uuid, uuid, text) from public, anon;
revoke execute on function public.count_splitwise_review(uuid) from public, anon;
revoke execute on function public.dismiss_splitwise_review(uuid) from public, anon;
revoke execute on function public.reject_splitwise_match(uuid, text) from public, anon;
grant execute on function public.get_splitwise_connection() to authenticated;
grant execute on function public.link_splitwise_review(uuid, uuid, text) to authenticated;
grant execute on function public.count_splitwise_review(uuid) to authenticated;
grant execute on function public.dismiss_splitwise_review(uuid) to authenticated;
grant execute on function public.reject_splitwise_match(uuid, text) to authenticated;

-- ---- Schedule ----

-- Every 6 h, 10 minutes after post-sync (UTC). Needs the Edge Function sync-splitwise deployed
-- (verify_jwt = false) and call_edge_function from 20261118000000_schedule_sync.sql. Users
-- without a connection cost nothing. cron.schedule replaces a job of the same name.
select cron.schedule('sync-splitwise', '42 */6 * * *', $$select public.call_edge_function('sync-splitwise')$$);
