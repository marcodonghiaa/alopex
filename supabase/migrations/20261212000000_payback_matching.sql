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
-- ("Cristian  FIORE." = "cristian fiore"). Null when nothing is left.
create or replace function public.payer_key(p_name text)
returns text
language sql
immutable
set search_path to ''
as $$
  select nullif(trim(regexp_replace(translate(lower(coalesce(p_name, '')),
    'àáâãäåèéêëìíîïòóôõöùúûüýÿçñ', 'aaaaaaeeeeiiiiooooouuuuyycn'), '[^[:alnum:]]+', ' ', 'g')), '')
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
grant select, insert, update, delete on public.payer_links to service_role;

-- Incoming payments from the last p_days not checked yet: not between your own accounts, not a
-- paired transfer, not a refund. amount_eur at the booking day's rate (null without a rate).
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
     and t.credit_debit_indicator = 'CRDT'
     and t.deleted_at is null
     and t.payback_contact is null
     and t.refund_of is null
     and coalesce(t.own_counterparty, false) = false
     and coalesce(t.flow_source, '') not in ('own_account', 'pair')
     and t.amount > 0
     and t.booking_date >= current_date - least(greatest(coalesce(p_days, 60), 1), 366)
   order by t.booking_date desc, t.entry_reference
   limit 200
$$;

-- Confirms that a payment is p_contact paying you back: the payment stops counting as income (a
-- transfer), and that person's open split bills are settled oldest first while the payment covers
-- them in full. A bill it can't cover stays open (bills are settled whole, never in part); what is
-- left over is returned. p_contact '' records "not a payback" and changes nothing else.
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
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if p_account is null or p_ref is null then raise exception 'Payment not found'; end if;
  if char_length(v_contact) > 100 then raise exception 'Contact name too long'; end if;

  select * into v_credit from public.transactions
   where user_id = uid and account_uid = p_account and entry_reference = p_ref
     and credit_debit_indicator = 'CRDT' and deleted_at is null
   for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_credit.payback_contact is not null then raise exception 'Payment already checked'; end if;

  if v_contact = '' then
    update public.transactions set payback_contact = ''
     where account_uid = p_account and entry_reference = p_ref;
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

  -- That person's own open bills (a bill shared with others has one settled flag for everyone, so
  -- it is left to settle by hand), oldest first. Same rows as the Who owes you page.
  for v_bill in
    select b.account_uid, b.entry_reference, round(b.owed_eur, 2) as owed_eur
      from (
        select t.account_uid, t.entry_reference, t.booking_date,
               v.personal_signed_amount_eur - v.signed_amount_eur as owed_eur
          from public.transactions t
          join public.v_transactions_eur v
            on v.account_uid = t.account_uid and v.entry_reference = t.entry_reference
         where t.user_id = uid and t.deleted_at is null
           and t.credit_debit_indicator = 'DBIT'
           and not t.owed_settled
           and t.personal_amount is not null and t.personal_amount >= 0 and t.personal_amount < t.amount
           and t.import_batch_id is null
           and coalesce(t.flow_type, 'spend') not in ('refunded', 'transfer')
           and position(',' in coalesce(t.owed_by, '')) = 0
           and lower(trim(t.owed_by)) = lower(v_contact)
      ) b
     order by b.booking_date, b.entry_reference
  loop
    exit when v_left is null or v_bill.owed_eur is null or v_bill.owed_eur > v_left + 0.005;
    update public.transactions
       set owed_settled = true, settled_at = now(),
           settled_by_account = p_account, settled_by_ref = p_ref
     where account_uid = v_bill.account_uid and entry_reference = v_bill.entry_reference;
    v_left := v_left - v_bill.owed_eur;
    v_settled_eur := v_settled_eur + v_bill.owed_eur;
    v_settled := v_settled || v_bill.entry_reference;
  end loop;

  if coalesce(p_remember, true) then
    v_key := public.payer_key(public.payer_name_of(v_credit.debtor_name, v_credit.creditor_name));
    if v_key is not null then
      insert into public.payer_links (user_id, payer_key, contact) values (uid, left(v_key, 200), v_contact)
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

revoke execute on function public.payback_candidates(integer) from public, anon;
revoke execute on function public.record_payback(uuid, text, text, boolean) from public, anon;
revoke execute on function public.undo_payback(uuid, text, boolean) from public, anon;
grant execute on function public.payback_candidates(integer) to authenticated;
grant execute on function public.record_payback(uuid, text, text, boolean) to authenticated;
grant execute on function public.undo_payback(uuid, text, boolean) to authenticated;
