-- Asserts for 20261215000000 (local only). Runs in one rolled-back transaction, from the repo root:
--   T=supabase/migrations/20261215000000_investment_events.sql
--   ( echo 'begin;'; cat $T supabase/rehearsals/investment_events.assert.sql \
--       supabase/rollbacks/20261215000000_investment_events.down.sql; cat $T; echo 'rollback;' ) \
--     | docker exec -i supabase_db_finance_app psql -U postgres -v ON_ERROR_STOP=1
-- Success prints no error. The rollback must work, and the migration must apply again on top.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'e1@example.test');

do $$
declare
  u uuid := '00000000-0000-0000-0000-0000000000e1';
  n integer;
begin
  -- a dividend after tax, a fee, a transfer with no cash
  insert into public.investment_events (user_id, kind, asset_kind, key, event_date, amount_eur, tax_eur, raw_type, source, external_id) values
    (u, 'dividend', 'stock', 'XX0000000001', '2026-03-01', 0.89, 0.31, 'CASH|DIVIDEND', 'trade_republic', 'a'),
    (u, 'fee', null, null, '2026-03-02', -1, 0, 'CASH|FEE', 'trade_republic', 'b');
  insert into public.investment_events (user_id, kind, asset_kind, key, event_date, amount_eur, shares, raw_type) values
    (u, 'transfer_in', 'crypto', 'BTC', '2026-03-03', 0, 0.1, 'IN');

  -- the same id again is skipped by on conflict do nothing
  insert into public.investment_events (user_id, kind, event_date, amount_eur, raw_type, source, external_id)
    values (u, 'interest', '2026-03-04', 1, 'CASH|INTEREST_PAYMENT', 'trade_republic', 'a')
    on conflict (user_id, source, external_id) do nothing;
  select count(*) into n from public.investment_events where user_id = u;
  if n <> 3 then raise exception 'expected 3 events, got %', n; end if;

  begin
    insert into public.investment_events (user_id, kind, asset_kind, event_date, amount_eur, raw_type)
      values (u, 'dividend', 'stock', '2026-03-01', 1, 'X');
    raise exception 'an asset kind without a key must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.investment_events (user_id, kind, event_date, amount_eur, raw_type)
      values (u, 'card', '2026-03-01', 1, 'X');
    raise exception 'an unknown kind must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.investment_events (user_id, kind, event_date, amount_eur, tax_eur, raw_type)
      values (u, 'dividend', '2026-03-01', 1, -1, 'X');
    raise exception 'a negative tax must be refused';
  exception when check_violation then null;
  end;

  -- trades take the new optional columns; native price and currency come together
  insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, tax_eur, traded_at, note, currency, price_native)
    values (u, 'stock', 'XX0000000001', 'buy', '2026-03-01', 1, 10, 0.02, '2026-03-01T09:30:00Z', 'Savings plan', 'USD', 11);
  begin
    insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, currency)
      values (u, 'stock', 'K', 'buy', '2026-03-01', 1, 10, 'USD');
    raise exception 'a currency without a native price must be refused';
  exception when check_violation then null;
  end;
end $$;

-- deleting a holding deletes its events too, and leaves other holdings' events alone
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1"}', true);
insert into public.portfolio_holdings (user_id, isin, yahoo_symbol, name, shares, broker_label)
  values ('00000000-0000-0000-0000-0000000000e1', 'XX0000000001', 'X', 'Example', 1, 'Example');
do $$
begin
  perform public.delete_holding('stock', 'XX0000000001');
  if exists (select 1 from public.investment_events where key = 'XX0000000001') then
    raise exception 'the deleted holding''s events must go';
  end if;
  if not exists (select 1 from public.investment_events where key = 'BTC') then
    raise exception 'other holdings'' events must stay';
  end if;
end $$;

-- delete_holding runs as security definer: it refuses an absurdly long key or source, but still deletes a
-- 101-character key (holdings tables have no length limit, so such a key can exist)
do $$
begin
  begin
    perform public.delete_holding('stock', repeat('x', 1001));
    raise exception 'a key over 1000 characters must be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.delete_holding('stock', '');
    raise exception 'an empty key must be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.delete_holding('crypto', 'BTC', repeat('s', 1001));
    raise exception 'a source over 1000 characters must be refused';
  exception when invalid_parameter_value then null;
  end;
  -- a long but real key is not refused (0 rows deleted is fine)
  perform public.delete_holding('stock', repeat('x', 101));
  perform public.delete_holding('crypto', 'BTC', repeat('s', 41));
end $$;

-- a temp table can't stand in for a real one inside delete_holding (pg_temp is searched last)
insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur)
  values ('00000000-0000-0000-0000-0000000000e1', 'stock', 'XX0000000002', 'buy', '2026-03-01', 1, 10);
create temp table holding_trades (user_id uuid, kind text, key text);
do $$
begin
  perform public.delete_holding('stock', 'XX0000000002');
  if exists (select 1 from public.holding_trades where key = 'XX0000000002') then
    raise exception 'delete_holding must delete from public.holding_trades, not a temp table';
  end if;
end $$;
drop table pg_temp.holding_trades;

-- out-of-range prices, rates and times are refused like the other amounts and dates
do $$
declare
  u uuid := '00000000-0000-0000-0000-0000000000e1';
begin
  begin
    insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, currency, price_native)
      values (u, 'stock', 'K', 'buy', '2026-03-01', 1, 10, 'USD', 1e12);
    raise exception 'a native price of 1e12 must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, traded_at)
      values (u, 'stock', 'K', 'buy', '2026-03-01', 1, 10, '0001-01-01T00:00:00Z');
    raise exception 'a trade time before 1970 must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, traded_at)
      values (u, 'stock', 'K', 'buy', '2026-03-01', 1, 10, '2101-01-01T00:00:00Z');
    raise exception 'a trade time after 2100 must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.investment_events (user_id, kind, event_date, amount_eur, raw_type, orig_amount, orig_currency, fx_rate)
      values (u, 'dividend', '2026-03-01', 1, 'X', 1, 'USD', 1e6);
    raise exception 'an fx rate of 1e6 must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.investment_events (user_id, kind, event_date, amount_eur, raw_type, occurred_at)
      values (u, 'dividend', '2026-03-01', 1, 'X', '0001-01-01T00:00:00Z');
    raise exception 'an event time before 1970 must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.investment_events (user_id, kind, event_date, amount_eur, raw_type, occurred_at)
      values (u, 'dividend', '2026-03-01', 1, 'X', '2101-01-01T00:00:00Z');
    raise exception 'an event time after 2100 must be refused';
  exception when check_violation then null;
  end;
  -- the edges themselves are fine
  insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, currency, price_native, traded_at)
    values (u, 'stock', 'K', 'buy', '2026-03-01', 1, 10, 'USD', 999999999999, '2100-12-31T00:00:00Z');
  insert into public.investment_events (user_id, kind, event_date, amount_eur, raw_type, orig_amount, orig_currency, fx_rate, occurred_at)
    values (u, 'dividend', '2026-03-01', 1, 'X', 1, 'USD', 999999, '1970-01-01T00:00:00Z');
end $$;
