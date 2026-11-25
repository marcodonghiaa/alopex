-- Rollback of 20270116000000_holding_trades_finite: trades take NaN and Infinity again.
alter table public.holding_trades drop constraint if exists holding_trades_numbers_finite;
