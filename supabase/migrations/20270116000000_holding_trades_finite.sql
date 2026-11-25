-- H189: holding_trades took NaN and Infinity: NaN sorts above every number in Postgres, so
-- `shares > 0` and `price_eur >= 0` passed it, and one such trade turned that holding's returns
-- into NaN. New writes must be finite (`< 'Infinity'` refuses both), as for the holdings in
-- 20261225000000. NOT VALID: rows stored before are not checked, so the migration never fails or
-- changes anyone's data; such a row has to be fixed or deleted before its next edit.
alter table public.holding_trades drop constraint if exists holding_trades_numbers_finite;
alter table public.holding_trades add constraint holding_trades_numbers_finite
  check (shares < 'Infinity'::numeric and price_eur < 'Infinity'::numeric and fee_eur < 'Infinity'::numeric) not valid;
