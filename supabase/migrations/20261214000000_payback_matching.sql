-- Match an incoming bank payment to someone who owes you ("Is this Anna?").
--   * transactions.payback_contact: on a credit, who paid you back (the contact's name as written on
--     your split bills or in Splitwise). '' = you said it is not a payback; null = not checked yet.
--   * transactions.settled_by_account / settled_by_ref: on a split bill, the payment that settled
--     it, so undoing that payment reopens exactly those bills.
--   * payer_links: a payer name as the bank writes it, linked to a contact once you confirm it, so
--     the next payment from that name is suggested straight away. Names only, never IBANs.
--   * payback_candidates(days): recent incoming payments not checked yet, with their payer.
--   * record_payback / undo_payback: confirm (or dismiss) and take it back.
-- Everything runs as the caller (security invoker), so row level security decides what is touched.

alter table public.transactions
  add column if not exists payback_contact text
    constraint transactions_payback_contact_length check (char_length(payback_contact) <= 100),
  add column if not exists settled_by_account uuid,
  add column if not exists settled_by_ref text;

create index if not exists transactions_settled_by_idx
  on public.transactions (user_id, settled_by_account, settled_by_ref)
  where settled_by_ref is not null;

-- How a payer's name is compared: case, accents, spacing and punctuation don't matter
-- ("Mario  VERDI." = "mario verdi"). Null when nothing is left.
create or replace function public.payer_key(p_name text)
returns text
language sql
immutable
set search_path to ''
as $$
  -- Reads at most 1000 characters (a bank name is far shorter; a huge one costs nothing extra).
  -- Cut to the 200 letters payer_links keeps, here, so the saved key and the lookup key are the same.
  select nullif(trim(left(trim(regexp_replace(
    replace(replace(replace(translate(lower(left(coalesce(p_name, ''), 1000)),
      'àáâãäåèéêëìíîïòóôõöùúûüýÿçñăāąćčĉċďđēėęěĕğģĝġħĥīįıĭĩĵķĺļľłńņňōőŏøŕřŗśšşșŝťţțũūůűųŭŵŷźžż',
      'aaaaaaeeeeiiiiooooouuuuyycnaaaccccddeeeeegggghhiiiiijkllllnnnoooorrrssssstttuuuuuuwyzzz'),
      'ß', 'ss'), 'æ', 'ae'), 'œ', 'oe'),
    '[^[:alnum:]]+', ' ', 'g')), 200)), '')
$$;

-- On an incoming payment the payer is the debtor; some banks leave it empty and put the payer in
-- creditor_name. Bank fields only: a name you gave the row is not what the bank sends next time.
create or replace function public.payer_name_of(p_debtor text, p_creditor text)
returns text
language sql
immutable
set search_path to ''
as $$
  select coalesce(nullif(trim(p_debtor), ''), nullif(trim(p_creditor), ''))
$$;

create table if not exists public.payer_links (
  user_id uuid not null references auth.users (id) on delete cascade,
  payer_key text not null check (char_length(payer_key) between 1 and 200),
  contact text not null check (char_length(contact) between 1 and 100),
  created_at timestamptz not null default now(),
  primary key (user_id, payer_key)
);

alter table public.payer_links enable row level security;

drop policy if exists "Users manage own payer links" on public.payer_links;
create policy "Users manage own payer links" on public.payer_links
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.payer_links from anon;
grant select, insert, update, delete on public.payer_links to authenticated;
-- Supabase's default grants also give truncate (which ignores RLS), references and trigger.
revoke truncate, references, trigger on public.payer_links from authenticated;
grant select, insert, update, delete on public.payer_links to service_role;

-- Plain income only: money already counted another way is never a payback. Not a transfer (yours,
-- a paired one, or one you marked), not a Splitwise settle-up the import linked, not a split refund
-- (it already lowers what someone owes), not a refund, not money between your own accounts.
create or replace function public.payback_eligible(t public.transactions)
returns boolean
language sql
stable
set search_path to ''
as $$
  select t.credit_debit_indicator = 'CRDT'
     and t.deleted_at is null
     and t.amount > 0
     and coalesce(t.flow_type, 'income') = 'income'
     and t.import_batch_id is null
     and t.personal_amount is null
     and t.refund_of is null
     and not coalesce(t.own_counterparty, false)
$$;

-- Incoming payments from the last p_days not checked yet (see payback_eligible). amount_eur at the booking day's rate (null without a rate).
create or replace function public.payback_candidates(p_days integer default 60)
returns table (
  account_uid uuid,
  entry_reference text,
  booking_date date,
  amount numeric,
  currency text,
  amount_eur numeric,
  payer text,
  linked_contact text
)
language sql
stable
security invoker
set search_path to 'public'
as $$
  select t.account_uid, t.entry_reference, t.booking_date, t.amount, t.currency,
         round(t.amount * fx.rate_to_eur, 2),
         public.payer_name_of(t.debtor_name, t.creditor_name),
         l.contact
    from public.transactions t
    left join lateral (
      select coalesce(
        (select r.rate_to_eur from public.fx_rates r
          where r.currency = t.currency and r.date <= t.booking_date
          order by r.date desc limit 1),
        case when t.currency = 'EUR' then 1::numeric end) as rate_to_eur
    ) fx on true
    left join public.payer_links l
      on l.user_id = t.user_id
     and l.payer_key = public.payer_key(public.payer_name_of(t.debtor_name, t.creditor_name))
   where t.user_id = (select auth.uid())
     and public.payback_eligible(t)
     and t.payback_contact is null
     and t.booking_date >= current_date - least(greatest(coalesce(p_days, 60), 1), 366)
   order by t.booking_date desc, t.entry_reference
   limit 200
$$;

-- Confirms that a payment is p_contact paying you back: the payment stops counting as income (a
-- transfer), and that person's open split bills are settled oldest first while the payment covers
-- them in full. A bill it can't cover stays open (bills are settled whole, never in part); what is
-- left over is returned. p_contact '' records "not a payback" and unlinks that payer's name.
-- p_remember links the payer's name to the contact for next time.
create or replace function public.record_payback(
  p_account uuid,
  p_ref text,
  p_contact text,
  p_remember boolean default true
)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  v_contact text := trim(coalesce(p_contact, ''));
  v_credit public.transactions%rowtype;
  v_left numeric;
  v_settled_eur numeric := 0;
  v_key text;
  v_linked boolean := false;
  v_settled text[] := '{}';
  v_bill record;
  v_credits numeric := 0;
  v_rows jsonb;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if p_account is null or p_ref is null then raise exception 'Payment not found'; end if;
  -- '' means "not a payback"; a missing name is a client bug, never a silent dismissal.
  if p_contact is null then raise exception 'Contact required'; end if;
  if char_length(v_contact) > 100 then raise exception 'Contact name too long'; end if;
  -- One payback at a time per user: two confirmed at once would each count the same open bills and
  -- refunds. The second waits, then reads what the first wrote.
  perform pg_advisory_xact_lock(hashtextextended('record_payback:' || uid::text, 0));

  select * into v_credit from public.transactions
   where user_id = uid and account_uid = p_account and entry_reference = p_ref
     and credit_debit_indicator = 'CRDT' and deleted_at is null
   for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_credit.payback_contact is not null then raise exception 'Payment already checked'; end if;
  if not public.payback_eligible(v_credit) then raise exception 'Payment not found'; end if;

  if v_contact = '' then
    update public.transactions set payback_contact = ''
     where account_uid = p_account and entry_reference = p_ref;
    -- A payer you linked sent money that is not a payback: the link was a guess too far, drop it
    -- (their next payment is matched by name or amount again).
    delete from public.payer_links
     where user_id = uid
       and payer_key = public.payer_key(public.payer_name_of(v_credit.debtor_name, v_credit.creditor_name));
    return jsonb_build_object('settled', '[]'::jsonb, 'settled_eur', 0, 'left_eur', null, 'linked', false);
  end if;

  update public.transactions set payback_contact = v_contact, flow_type = 'transfer'
   where account_uid = p_account and entry_reference = p_ref;

  -- The payment in euros, as the dashboard counts it (no rate: nothing is settled).
  select round(v_credit.amount * coalesce(
      (select r.rate_to_eur from public.fx_rates r
        where r.currency = v_credit.currency and r.date <= v_credit.booking_date
        order by r.date desc limit 1),
      case when v_credit.currency = 'EUR' then 1::numeric end), 2)
    into v_left;

  -- That person's own open split rows (a bill shared with others has one settled flag for everyone,
  -- so it is left to settle by hand). Same rows as the Who owes you page: bills they owe on, and
  -- split refunds that count against them, oldest first.
  select coalesce(jsonb_agg(jsonb_build_object(
           'account_uid', r.account_uid, 'entry_reference', r.entry_reference, 'owed_eur', r.owed_eur)
           order by r.booking_date, r.entry_reference), '[]'::jsonb)
    into v_rows
    from (
      select t.account_uid, t.entry_reference, t.booking_date,
             round(v.personal_signed_amount_eur - v.signed_amount_eur, 2) as owed_eur
        from public.transactions t
        join public.v_transactions_eur v
          on v.account_uid = t.account_uid and v.entry_reference = t.entry_reference
       where t.user_id = uid and t.deleted_at is null
         and not t.owed_settled
         and t.personal_amount is not null and t.personal_amount >= 0
         and t.import_batch_id is null
         and coalesce(t.flow_type, '') not in ('refunded', 'transfer')
         -- Names as the page reads them: comma-separated, blanks dropped ("Carla," is Carla alone).
         and array(select lower(trim(n)) from unnest(string_to_array(t.owed_by, ',')) n where trim(n) <> '')
             = array[lower(v_contact)]
         and v.personal_signed_amount_eur - v.signed_amount_eur <> 0
    ) r;
  -- Refunds owed to them add to the money; bills settle oldest first, whole.
  select coalesce(sum(x.owed_eur), 0) into v_credits
    from jsonb_to_recordset(v_rows) as x(owed_eur numeric) where x.owed_eur < 0;
  v_left := v_left - v_credits;

  for v_bill in
    select x.account_uid, x.entry_reference, x.owed_eur
      from jsonb_array_elements(v_rows) with ordinality as e(r, n),
           jsonb_to_record(e.r) as x(account_uid uuid, entry_reference text, owed_eur numeric)
     where x.owed_eur > 0
     order by e.n
  loop
    exit when v_left is null or v_bill.owed_eur > v_left + 0.005;
    update public.transactions
       set owed_settled = true, settled_at = now(),
           settled_by_account = p_account, settled_by_ref = p_ref
     where account_uid = v_bill.account_uid and entry_reference = v_bill.entry_reference
       and not owed_settled;
    -- Another payment settled it after this list was read (two confirmed at once): skip it.
    continue when not found;
    v_left := v_left - v_bill.owed_eur;
    v_settled_eur := v_settled_eur + v_bill.owed_eur;
    v_settled := v_settled || v_bill.entry_reference;
  end loop;

  if v_credits < 0 then
    if v_settled_eur + v_credits >= -0.005 then
      -- The settled bills use the refunds in full: close them too (undo reopens them with the bills).
      update public.transactions t
         set owed_settled = true, settled_at = now(),
             settled_by_account = p_account, settled_by_ref = p_ref
        from jsonb_to_recordset(v_rows) as x(account_uid uuid, entry_reference text, owed_eur numeric)
       where x.owed_eur < 0 and t.account_uid = x.account_uid
         and t.entry_reference = x.entry_reference and not t.owed_settled;
      v_settled_eur := v_settled_eur + v_credits;
    else
      -- They would use only part of a refund, which can't be settled in part: settle nothing.
      update public.transactions
         set owed_settled = false, settled_at = null, settled_by_account = null, settled_by_ref = null
       where user_id = uid and settled_by_account = p_account and settled_by_ref = p_ref;
      v_left := v_left + v_credits + v_settled_eur;
      v_settled_eur := 0;
      v_settled := '{}';
    end if;
  end if;

  if coalesce(p_remember, true) then
    v_key := public.payer_key(public.payer_name_of(v_credit.debtor_name, v_credit.creditor_name));
    if v_key is not null then
      insert into public.payer_links (user_id, payer_key, contact) values (uid, v_key, v_contact)
      on conflict (user_id, payer_key) do update set contact = excluded.contact
      where payer_links.contact is distinct from excluded.contact;
      v_linked := found;
    end if;
  end if;

  return jsonb_build_object(
    'settled', to_jsonb(v_settled),
    'settled_eur', v_settled_eur,
    'left_eur', case when v_left is null then null else greatest(round(v_left, 2), 0) end,
    'linked', v_linked);
end;
$$;

-- Takes a recorded payback back: the payment goes back to being classified by the app, the bills
-- it settled reopen, and with p_forget the payer's name is unlinked.
create or replace function public.undo_payback(p_account uuid, p_ref text, p_forget boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  v_credit public.transactions%rowtype;
  v_reopened int;
begin
  if uid is null then raise exception 'Not signed in'; end if;

  select * into v_credit from public.transactions
   where user_id = uid and account_uid = p_account and entry_reference = p_ref
     and credit_debit_indicator = 'CRDT'
   for update;
  if not found or v_credit.payback_contact is null then raise exception 'Payment not found'; end if;

  update public.transactions
     set owed_settled = false, settled_at = null, settled_by_account = null, settled_by_ref = null
   where user_id = uid and settled_by_account = p_account and settled_by_ref = p_ref;
  get diagnostics v_reopened = row_count;

  update public.transactions
     set payback_contact = null,
         flow_type = case when v_credit.payback_contact = '' then flow_type else null end
   where account_uid = p_account and entry_reference = p_ref;

  if coalesce(p_forget, false) then
    delete from public.payer_links
     where user_id = uid
       and payer_key = public.payer_key(public.payer_name_of(v_credit.debtor_name, v_credit.creditor_name));
  end if;

  return jsonb_build_object('reopened', v_reopened);
end;
$$;

-- The helpers too: nothing here is for callers who aren't signed in.
revoke execute on function public.payer_key(text) from public, anon;
revoke execute on function public.payer_name_of(text, text) from public, anon;
revoke execute on function public.payback_eligible(public.transactions) from public, anon;
grant execute on function public.payer_key(text) to authenticated, service_role;
grant execute on function public.payer_name_of(text, text) to authenticated, service_role;
grant execute on function public.payback_eligible(public.transactions) to authenticated, service_role;
revoke execute on function public.payback_candidates(integer) from public, anon;
revoke execute on function public.record_payback(uuid, text, text, boolean) from public, anon;
revoke execute on function public.undo_payback(uuid, text, boolean) from public, anon;
grant execute on function public.payback_candidates(integer) to authenticated;
grant execute on function public.record_payback(uuid, text, text, boolean) to authenticated;
grant execute on function public.undo_payback(uuid, text, boolean) to authenticated;
