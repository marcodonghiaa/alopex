-- Rollback of 20261215000000_investment_events. Imported dividends, interest, fees, taxes and
-- transfers are lost (importing the broker files again brings them back); trades stay, without
-- their tax, time, note, native price and group (a re-import skips them,
-- so that detail stays lost).
set local lock_timeout = '5s';

drop table if exists public.investment_events;
alter table public.holding_trades
  drop constraint if exists holding_trades_native_pair,
  drop column if exists group_id,
  drop column if exists price_native,
  drop column if exists currency,
  drop column if exists note,
  drop column if exists traded_at,
  drop column if exists tax_eur;

-- delete_holding as in 20261110000000.
create or replace function public.delete_holding(p_kind text, p_key text, p_source text default null)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  if p_kind = 'stock' then
    delete from portfolio_snapshots where user_id = v_uid and isin = p_key;
    delete from portfolio_holdings where user_id = v_uid and isin = p_key;
    get diagnostics v_count = row_count;
    delete from holding_trades where user_id = v_uid and kind = 'stock' and key = p_key;
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
    end if;
  else
    raise exception 'unknown kind %', p_kind;
  end if;

  return v_count;
end;
$$;
