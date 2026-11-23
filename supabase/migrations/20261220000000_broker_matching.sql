-- Broker rows matched to the broker's own export (e2e test 2026-11-22 #23).
-- Trade Republic over Enable Banking sends a date and an amount, nothing else: a buy looked like
-- spending and a deposit like income. Once you import the broker's CSV (Investing -> Import),
-- match_broker_rows finds, for each bank row, the CSV row it came from (same user, same amount to
-- the cent, same day or within 3 days, and only when exactly one fits both ways) and:
--   * broker_ref   remembers which one ('trade:<holding_trades.id>' or 'event:<investment_events.id>')
--   * broker_label names it ("Buy World ETF", "Interest", "Saveback", "Tax")
--   * flow / category: buys, sells, deposits and withdrawals are transfers (Transfer); dividends,
--     interest, Saveback and tax refunds are income (Income); taxes are spending (Taxes); fees (Others).
-- What you set by hand stays: a flow you chose (or a rule's, or your own-account transfer) and a
-- category you picked are never changed. Undo the import and the rows go back to spend/income.
-- post-sync runs it for everyone after each sync; the dashboard after an import and after Undo.

set local lock_timeout = '5s';

alter table public.transactions
  add column if not exists broker_ref text
    constraint transactions_broker_ref_length check (char_length(broker_ref) <= 60),
  add column if not exists broker_label text
    constraint transactions_broker_label_length check (char_length(broker_label) <= 200);

-- One bank row per broker row; also what the matcher looks up.
create unique index if not exists transactions_broker_ref_idx
  on public.transactions (user_id, broker_ref)
  where broker_ref is not null;

alter table public.transactions drop constraint if exists transactions_flow_source_check;
alter table public.transactions add constraint transactions_flow_source_check
  check (flow_source in ('user', 'legacy', 'rule', 'own_account', 'pair', 'bank', 'default', 'broker'));

-- A flow set by match_broker_rows for a signed-in caller stays 'broker' (not 'user'), so a later
-- Undo can give it back to post-sync.
create or replace function public.flow_source_user() returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if current_setting('alopex.broker_match', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' or new.flow_type is distinct from old.flow_type
     or new.flow_source is distinct from old.flow_source then
    new.flow_source := case when new.flow_type is null then null else 'user' end;
  end if;
  return new;
end;
$$;
revoke execute on function public.flow_source_user() from public, anon, authenticated;

-- A category the matcher sets is the matcher's ('rule'), not a hand pick ('manual').
create or replace function public.mark_manual_category()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if current_setting('alopex.broker_match', true) = 'on' then
    return new;
  end if;
  new.category_source := 'manual';
  return new;
end;
$function$;
revoke execute on function public.mark_manual_category() from public, anon, authenticated;

-- Same guard as 20261205000000, plus broker_ref and broker_label: only the matcher writes them.
create or replace function public.restrict_transaction_updates()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_manual boolean := exists (select 1 from accounts where uid = old.account_uid and manual);
begin
  -- match_broker_rows (below) labels bank rows for the caller; nothing else turns this on.
  if current_setting('alopex.broker_match', true) = 'on' then
    return new;
  end if;
  if new.entry_reference is distinct from old.entry_reference
     or new.account_uid is distinct from old.account_uid
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at
     or new.raw is distinct from old.raw
     or new.debtor_name is distinct from old.debtor_name
     or new.remittance_info is distinct from old.remittance_info
     or new.bank_transaction_code is distinct from old.bank_transaction_code
     or new.own_counterparty is distinct from old.own_counterparty
     or new.refund_of is distinct from old.refund_of
     or new.broker_ref is distinct from old.broker_ref
     or new.broker_label is distinct from old.broker_label
     or (new.merchant_key is not null and new.merchant_key is distinct from old.merchant_key)
     or (not v_manual and (
          new.amount is distinct from old.amount
       or new.currency is distinct from old.currency
       or new.credit_debit_indicator is distinct from old.credit_debit_indicator
       or new.creditor_name is distinct from old.creditor_name
       or new.booking_date is distinct from old.booking_date
       or new.value_date is distinct from old.value_date))
  then
    raise exception 'Bank-provided fields on transactions cannot be changed';
  end if;
  return new;
end;
$function$;

-- The name the bank didn't send: your own name for the row first, then the broker's.
create or replace view public.v_transactions_eur with (security_invoker = true) as
 select t.user_id,
    t.entry_reference,
    t.account_uid,
    t.booking_date,
    t.category,
    coalesce(t.custom_name, t.broker_label, t.creditor_name) as creditor_name,
    t.currency,
    t.amount,
    (case when t.credit_debit_indicator = 'DBIT' then -1 else 1 end)::numeric * t.amount * fx.rate_to_eur as signed_amount_eur,
    t.transaction_type,
    t.credit_debit_indicator,
    t.created_at,
    t.worth_it,
    (case when t.credit_debit_indicator = 'DBIT' then -1 else 1 end)::numeric * coalesce(t.personal_amount, t.amount) * fx.rate_to_eur as personal_signed_amount_eur,
    coalesce(t.flow_type, case when t.credit_debit_indicator = 'DBIT' then 'spend' else 'income' end) as flow_type,
    t.personal_amount,
    t.owed_by,
    t.owed_settled,
    t.settled_at,
    t.refund_of,
    t.note,
    t.tags,
    coalesce(t.custom_name, t.broker_label, t.debtor_name) as payer_name
   from public.transactions t
     left join lateral (
        select coalesce(
          (select fx_rates.rate_to_eur
           from public.fx_rates
           where fx_rates.currency = t.currency and fx_rates.date <= t.booking_date
           order by fx_rates.date desc
           limit 1),
          case when t.currency = 'EUR' then 1::numeric end
        ) as rate_to_eur
      ) fx on true
   where t.deleted_at is null;

-- Which bank's rows each broker import can explain: the import's source, the account's bank_name.
-- One line per broker; nothing else in this file names a broker.
create or replace function public.broker_sources()
returns table (source text, bank_name text)
language sql
immutable
set search_path = ''
as $$
  values ('trade_republic', 'Trade Republic')
$$;

create or replace function public.match_broker_rows(p_user uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(auth.role(), '');
  v_user uuid := p_user;
  v_cleared int := 0;
  v_matched int := 0;
  v_n int;
  v_unmatched int;
  v_tier int;
begin
  -- Signed in: only your own rows. Service role (post-sync) or the database itself: p_user, or everyone.
  if v_role = 'authenticated' then
    if p_user is not null and p_user is distinct from auth.uid() then
      raise exception 'You can only match your own rows';
    end if;
    v_user := auth.uid();
  elsif v_role not in ('service_role', '') then
    raise exception 'Sign in to match broker rows';
  end if;
  perform set_config('alopex.broker_match', 'on', true);

  -- 1. Rows whose broker row is gone (import undone): back to how the bank sent them.
  update public.transactions t
     set broker_ref = null,
         broker_label = null,
         flow_type = case when t.flow_source = 'broker'
                          then case when t.credit_debit_indicator = 'DBIT' then 'spend' else 'income' end
                          else t.flow_type end,
         flow_source = case when t.flow_source = 'broker' then 'default' else t.flow_source end,
         category = case when t.category_source = 'rule' then null else t.category end,
         category_source = case when t.category_source = 'rule' then null else t.category_source end
   where t.broker_ref is not null
     and (v_user is null or t.user_id = v_user)
     and not exists (select 1 from public.holding_trades h
                      where h.user_id = t.user_id and t.broker_ref = 'trade:' || h.id)
     and not exists (select 1 from public.investment_events e
                      where e.user_id = t.user_id and t.broker_ref = 'event:' || e.id);
  get diagnostics v_cleared = row_count;

  -- 2. Match: same day first, then within 3 days. A row matched in a tier is out of the next one.
  for v_tier in 1..2 loop
    with sources as (select * from public.broker_sources()),
    bank as (
      select t.user_id, t.account_uid, t.entry_reference, t.booking_date as d, s.source,
             round(case when t.credit_debit_indicator = 'DBIT' then -abs(t.amount) else abs(t.amount) end, 2) as amt
        from public.transactions t
        join public.accounts a on a.uid = t.account_uid
        join sources s on s.bank_name = a.bank_name
       where (v_user is null or t.user_id = v_user)
         and t.deleted_at is null
         and t.broker_ref is null
         and t.currency = 'EUR'
         and t.booking_date is not null
         and t.flow_type is distinct from 'refunded'
         and coalesce(t.flow_source, 'default') in ('default', 'bank', 'pair')
    ),
    cands as (
      select h.user_id, h.source, 'trade:' || h.id as ref, h.trade_date as d,
             round(case when h.side = 'buy' then -(h.shares * h.price_eur + h.fee_eur + h.tax_eur)
                        else h.shares * h.price_eur - h.fee_eur - h.tax_eur end, 2) as amt,
             'transfer' as flow, 'Transfer' as cat,
             (case when h.side = 'buy' then 'Buy ' else 'Sell ' end) || coalesce(ph.name, h.key) as label
        from public.holding_trades h
        left join public.portfolio_holdings ph on ph.user_id = h.user_id and ph.isin = h.key
       where (v_user is null or h.user_id = v_user)
         and h.source in (select source from sources)
      union all
      select e.user_id, e.source, 'event:' || e.id, e.event_date, round(e.amount_eur, 2),
             case when e.kind in ('dividend', 'interest', 'reward', 'tax_refund') then 'income'
                  when e.kind in ('tax', 'fee') then 'spend'
                  else 'transfer' end,
             case when e.kind in ('dividend', 'interest', 'reward', 'tax_refund') then 'Income'
                  when e.kind = 'tax' then 'Taxes'
                  when e.kind = 'fee' then 'Others'
                  else 'Transfer' end,
             case e.kind
               when 'dividend' then 'Dividend ' || coalesce(ph.name, e.key, '')
               when 'interest' then 'Interest'
               when 'reward' then case when e.raw_type ilike '%saveback%' then 'Saveback' else 'Reward' end
               when 'tax' then 'Tax'
               when 'tax_refund' then 'Tax refund'
               when 'fee' then 'Fee'
               when 'deposit' then 'Deposit'
               when 'withdrawal' then 'Withdrawal'
               else 'Shares moved' end
        from public.investment_events e
        left join public.portfolio_holdings ph on ph.user_id = e.user_id and ph.isin = e.key
       where (v_user is null or e.user_id = v_user)
         and e.source in (select source from sources)
         and e.kind not in ('corporate_action', 'other')
         and e.amount_eur <> 0
    ),
    free as (
      select c.* from cands c
       where not exists (select 1 from public.transactions t
                          where t.user_id = c.user_id and t.broker_ref = c.ref)
    ),
    pairs as (
      select b.user_id, b.account_uid, b.entry_reference, f.ref, f.flow, f.cat, trim(f.label) as label,
             count(*) over (partition by b.account_uid, b.entry_reference) as per_bank,
             count(*) over (partition by f.user_id, f.ref) as per_cand
        from bank b
        join free f on f.user_id = b.user_id and f.source = b.source
                   and abs(f.amt - b.amt) <= 0.02
                   and (case when v_tier = 1 then f.d = b.d else abs(f.d - b.d) <= 3 end)
    )
    update public.transactions t
       set broker_ref = p.ref,
           broker_label = p.label,
           flow_type = case when coalesce(t.flow_source, 'default') in ('default', 'bank') then p.flow else t.flow_type end,
           flow_source = case when coalesce(t.flow_source, 'default') in ('default', 'bank') then 'broker' else t.flow_source end,
           category = case when t.category_source in ('manual', 'legacy') then t.category else p.cat end,
           category_source = case when t.category_source in ('manual', 'legacy') then t.category_source else 'rule' end
      from pairs p
     where p.per_bank = 1 and p.per_cand = 1
       and t.account_uid = p.account_uid and t.entry_reference = p.entry_reference;
    get diagnostics v_n = row_count;
    v_matched := v_matched + v_n;
  end loop;

  -- 3. What's left on broker accounts: shown as "N not matched yet".
  select count(*) into v_unmatched
    from public.transactions t
    join public.accounts a on a.uid = t.account_uid
   where a.bank_name in (select s.bank_name from public.broker_sources() s)
     and (v_user is null or t.user_id = v_user)
     and t.deleted_at is null
     and t.broker_ref is null
     and t.currency = 'EUR'
     and t.flow_type is distinct from 'refunded'
     and coalesce(t.flow_source, 'default') in ('default', 'bank', 'pair');

  perform set_config('alopex.broker_match', 'off', true);
  return jsonb_build_object('matched', v_matched, 'cleared', v_cleared, 'unmatched', v_unmatched);
end;
$function$;

revoke execute on function public.match_broker_rows(uuid) from public, anon;
grant execute on function public.match_broker_rows(uuid) to authenticated, service_role;
