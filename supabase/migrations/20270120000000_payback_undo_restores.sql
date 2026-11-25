-- H297: undoing a payback (undo_payback) lost things the user had.
--   * With "forget", it deleted the payer link even when the payback had only replaced an earlier
--     one (Mario Rossi was Bea, the payback made it Anna; undo left no link). payer_links now keeps
--     the contact it replaced (replaced_contact) and undo puts it back.
--   * It cleared the payment's flow, though record_payback had overwritten one you set by hand
--     ('income'). transactions.payback_prior_flow keeps that hand-set flow and undo restores it; a
--     flow the app chose still goes back to the app (null), as before.
--   * settled_by_ref (users may write it) had no length cap. It holds a bank entry reference; any
--     stored one over 1000 characters can't be one and is cleared (the bill stays settled), then
--     the cap is validated.
-- record_payback and undo_payback as in 20261214000000; restrict_transaction_updates as in
-- 20270119000000, with payback_prior_flow allowed (both functions run as the caller).
-- Not changed: the payback columns stay user-writable (these functions are security invoker and
-- the dashboard clears settled_by_* itself), and names still compare with lower().

alter table public.transactions add column if not exists payback_prior_flow text;
alter table public.transactions drop constraint if exists transactions_payback_prior_flow_check;
alter table public.transactions add constraint transactions_payback_prior_flow_check
  check (payback_prior_flow in ('spend', 'income', 'transfer', 'refunded')) not valid;
alter table public.transactions validate constraint transactions_payback_prior_flow_check;

alter table public.payer_links add column if not exists replaced_contact text;
alter table public.payer_links drop constraint if exists payer_links_replaced_contact_length;
alter table public.payer_links add constraint payer_links_replaced_contact_length
  check (char_length(replaced_contact) between 1 and 100);

update public.transactions set settled_by_ref = null where char_length(settled_by_ref) > 1000;
alter table public.transactions drop constraint if exists transactions_settled_by_ref_length;
alter table public.transactions add constraint transactions_settled_by_ref_length
  check (char_length(settled_by_ref) <= 1000) not valid;
alter table public.transactions validate constraint transactions_settled_by_ref_length;

create or replace function public.restrict_transaction_updates()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user text[] := array[
    'category', 'category_source', 'transaction_type', 'transaction_type_source', 'worth_it',
    'worth_it_prompted_at', 'personal_amount', 'owed_by', 'owed_settled', 'settled_at', 'flow_type',
    'flow_source', 'deleted_at', 'import_batch_id', 'custom_name', 'note', 'tags', 'payback_contact',
    'settled_by_account', 'settled_by_ref', 'payback_prior_flow'];
  v_bank text[] := array[
    'amount', 'currency', 'credit_debit_indicator', 'creditor_name', 'booking_date', 'value_date'];
  v_free text[];
begin
  v_free := v_user || 'merchant_key'::text
    || case when exists (select 1 from public.accounts where uid = old.account_uid and manual)
         then v_bank else '{}'::text[] end;
  if (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free)
     or (new.merchant_key is not null and new.merchant_key is distinct from old.merchant_key)
  then
    raise exception 'Bank-provided fields on transactions cannot be changed';
  end if;
  return new;
end;
$function$;
revoke execute on function public.restrict_transaction_updates() from public, anon, authenticated;

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

  -- A flow you set by hand ('income') is kept for undo; one the app chose goes back to the app.
  update public.transactions set payback_contact = v_contact, flow_type = 'transfer',
         payback_prior_flow = case when v_credit.flow_source = 'user' then v_credit.flow_type end
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
      -- The contact it replaces is kept, so undo can put it back.
      on conflict (user_id, payer_key) do update
        set contact = excluded.contact, replaced_contact = payer_links.contact
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
  v_key text;
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
     set payback_contact = null, payback_prior_flow = null,
         flow_type = case when v_credit.payback_contact = '' then flow_type else v_credit.payback_prior_flow end
   where account_uid = p_account and entry_reference = p_ref;

  if coalesce(p_forget, false) then
    v_key := public.payer_key(public.payer_name_of(v_credit.debtor_name, v_credit.creditor_name));
    -- The link this payback replaced comes back; one it made new is deleted.
    update public.payer_links set contact = replaced_contact, replaced_contact = null
     where user_id = uid and payer_key = v_key
       and contact = v_credit.payback_contact and replaced_contact is not null;
    if not found then
      delete from public.payer_links where user_id = uid and payer_key = v_key;
    end if;
  end if;

  return jsonb_build_object('reopened', v_reopened);
end;
$$;

revoke execute on function public.record_payback(uuid, text, text, boolean) from public, anon;
revoke execute on function public.undo_payback(uuid, text, boolean) from public, anon;
grant execute on function public.record_payback(uuid, text, text, boolean) to authenticated;
grant execute on function public.undo_payback(uuid, text, boolean) to authenticated;
