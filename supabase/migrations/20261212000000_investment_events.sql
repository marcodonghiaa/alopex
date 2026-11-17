-- Everything a broker or exchange reports that isn't a buy or a sell: dividends, interest, rewards,
-- fees and taxes on their own, deposits and withdrawals, transfers of a coin or a share in or out,
-- corporate actions. One table for every integration (Trade Republic first, then IBKR, Coinbase,
-- Ledger), so returns can count income and each new broker adds no tables of its own.
-- Owner-only, written by the dashboard's importers (and later by sync jobs as service_role).
--
-- amount_eur is the cash effect in euro, signed: money in is positive (a dividend after tax), money
-- out negative (a fee, a withdrawal). tax_eur and fee_eur are what was held back from it, so
-- gross = amount_eur + tax_eur + fee_eur. A transfer of coins or shares has shares and may have
-- no cash (amount_eur 0). raw_type keeps the broker's own name for the row, so a type Alopex
-- doesn't know yet is stored as 'other' and can be read again later.
set local lock_timeout = '5s';

create table public.investment_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in (
    'dividend', 'interest', 'reward', 'fee', 'tax', 'tax_refund', 'deposit', 'withdrawal',
    'transfer_in', 'transfer_out', 'corporate_action', 'other'
  )),
  -- What it belongs to, when it belongs to a holding: 'stock' + ISIN, or 'crypto' + coin symbol.
  asset_kind text check (asset_kind in ('stock', 'crypto')),
  key text check (char_length(key) between 1 and 100),
  event_date date not null check (event_date between '1970-01-01' and '2100-12-31'),
  occurred_at timestamptz,
  amount_eur numeric not null check (abs(amount_eur) < 1e12),
  tax_eur numeric not null default 0 check (tax_eur >= 0 and tax_eur < 1e12),
  fee_eur numeric not null default 0 check (fee_eur >= 0 and fee_eur < 1e12),
  shares numeric check (shares >= 0 and shares < 1e15),
  -- A foreign dividend: what the broker received before converting, and the rate it used.
  orig_amount numeric check (abs(orig_amount) < 1e15),
  orig_currency text check (orig_currency ~ '^[A-Z]{3}$'),
  fx_rate numeric check (fx_rate > 0),
  raw_type text not null check (char_length(raw_type) between 1 and 80),
  note text check (char_length(note) <= 200),
  source text check (char_length(source) between 1 and 40),
  external_id text check (char_length(external_id) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint investment_events_key_needs_kind check ((key is null) = (asset_kind is null)),
  constraint investment_events_external_needs_source check (external_id is null or source is not null),
  -- A plain unique constraint (not a partial index), so an importer can insert with
  -- `on conflict do nothing` and a re-import skips what's saved. Rows without an id never collide.
  constraint investment_events_external unique (user_id, source, external_id)
);
create index investment_events_user_date on public.investment_events (user_id, event_date);
create index investment_events_user_key on public.investment_events (user_id, asset_kind, key, event_date)
  where key is not null;

alter table public.investment_events enable row level security;
create policy "Users can view own investment events" on public.investment_events
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can insert own investment events" on public.investment_events
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own investment events" on public.investment_events
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own investment events" on public.investment_events
  for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.investment_events from anon;
revoke truncate, references, trigger on public.investment_events from authenticated;
grant select, insert, update, delete on public.investment_events to authenticated;
grant select, insert, update, delete on public.investment_events to service_role;

-- Trades learn what brokers tell us beyond price and fee. All optional, so typed-in trades and
-- older imports stay valid.
--   tax_eur: tax charged on the trade (e.g. a financial transaction tax); it counts like a fee.
--   traded_at: the exact time, so two trades on one day keep their order.
--   note: what kind of buy it was (savings plan, saveback, round-up), from the broker.
--   currency / price_native: the price in the currency it traded in, when that isn't EUR.
--   group_id: rows that are one operation (a coin swap, a convert) share it.
alter table public.holding_trades
  add column tax_eur numeric not null default 0 check (tax_eur >= 0 and tax_eur < 1e12),
  add column traded_at timestamptz,
  add column note text check (char_length(note) <= 200),
  add column currency text check (currency ~ '^[A-Z]{3}$'),
  add column price_native numeric check (price_native >= 0),
  add column group_id text check (char_length(group_id) between 1 and 200),
  add constraint holding_trades_native_pair check ((currency is null) = (price_native is null));

-- Deleting a holding also deletes its events, like its trades (same rule for crypto: only when no
-- other source still holds the coin).
create or replace function public.delete_holding(p_kind text, p_key text, p_source text default null)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;
  -- Same limits as the key and source columns.
  if coalesce(char_length(p_key), 0) not between 1 and 100 then
    raise exception 'key must be 1 to 100 characters' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(p_source) > 40 then
    raise exception 'source must be at most 40 characters' using errcode = 'invalid_parameter_value';
  end if;

  if p_kind = 'stock' then
    delete from portfolio_snapshots where user_id = v_uid and isin = p_key;
    delete from portfolio_holdings where user_id = v_uid and isin = p_key;
    get diagnostics v_count = row_count;
    delete from holding_trades where user_id = v_uid and kind = 'stock' and key = p_key;
    delete from investment_events where user_id = v_uid and asset_kind = 'stock' and key = p_key;
  elsif p_kind = 'crypto' then
    if p_source is null then
      raise exception 'crypto needs a source';
    end if;
    delete from crypto_snapshots
      where user_id = v_uid and asset_symbol = p_key and source = p_source;
    delete from crypto_holdings
      where user_id = v_uid and asset_symbol = p_key and source = p_source;
    get diagnostics v_count = row_count;
    if not exists (select 1 from crypto_holdings where user_id = v_uid and asset_symbol = p_key) then
      delete from holding_trades where user_id = v_uid and kind = 'crypto' and key = p_key;
      delete from investment_events where user_id = v_uid and asset_kind = 'crypto' and key = p_key;
    end if;
  else
    raise exception 'unknown kind %', p_kind;
  end if;

  return v_count;
end;
$$;
