-- holding_performance as in 20261108000000_holding_trades, without the two price_history branches:
-- nothing has written that table since backfill-price-history.js left the sync, so on every new
-- install they never matched. A range that starts before a holding's first snapshot now reports
-- 'since' even where old backfilled rows exist. Also uses fx_rate_to_eur (20270106000000).
-- price_history and its rows stay (deprecated, read by nothing) until a later release drops it.
create or replace function public.holding_performance(p_from date, p_last_move boolean default false)
returns table (
  kind text,
  key text,
  name text,
  quantity numeric,
  start_date date,
  start_price_eur numeric,
  end_date date,
  end_price_eur numeric,
  status text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  uid uuid := (select auth.uid());
begin
  if p_from is null then
    raise exception 'p_from is required' using errcode = '22004';
  end if;

  return query
  with held as (
    select 'stock'::text as k, h.isin as ky, h.name as nm, h.shares as q, h.yahoo_symbol as sym
    from public.portfolio_holdings h
    where h.user_id = uid and (h.shares > 0 or exists (
      select 1 from public.holding_trades t where t.user_id = uid and t.kind = 'stock' and t.key = h.isin
    ))
    union all
    select 'crypto', c.asset_symbol, min(c.name), sum(c.amount), min(c.coingecko_id)
    from public.crypto_holdings c
    where c.user_id = uid
    group by c.asset_symbol
    having sum(c.amount) > 0 or exists (
      select 1 from public.holding_trades t where t.user_id = uid and t.kind = 'crypto' and t.key = c.asset_symbol
    )
  ),
  raw as (
    select held.k, held.ky, ps.snapshot_date as d, ps.price, ps.currency as cur
    from held join public.portfolio_snapshots ps
      on held.k = 'stock' and ps.user_id = uid and ps.isin = held.ky
    union all
    select held.k, held.ky, cs.snapshot_date, cs.price_usd, 'USD'
    from held join public.crypto_snapshots cs
      on held.k = 'crypto' and cs.user_id = uid and cs.asset_symbol = held.ky
  ),
  series as (
    select distinct on (k, ky, d) k, ky, d, price, cur
    from raw
    where price > 0
    order by k, ky, d, price
  ),
  last_row as (
    select distinct on (k, ky) k, ky, d, price, cur from series order by k, ky, d desc
  ),
  first_row as (
    select distinct on (k, ky) k, ky, d, price, cur from series order by k, ky, d
  ),
  pick as (
    select h.k, h.ky, h.nm, h.q,
      e.d as ed, e.price as ep, e.cur as ecur,
      coalesce(s.d, f.d) as sd, coalesce(s.price, f.price) as sp, coalesce(s.cur, f.cur) as scur,
      (e.d is not null and s.d is null) as is_since
    from held h
    left join last_row e on e.k = h.k and e.ky = h.ky
    left join first_row f on f.k = h.k and f.ky = h.ky
    left join lateral (
      select x.d, x.price, x.cur
      from series x
      where x.k = h.k and x.ky = h.ky and e.d is not null
        and x.d <= case when p_last_move then e.d - 1 else least(p_from, e.d) end
      order by (p_last_move and x.price is distinct from e.price and x.d >= e.d - 7) desc, x.d desc
      limit 1
    ) s on true
  ),
  priced as (
    select p.*,
      public.fx_rate_to_eur(p.ecur, p.ed) as erate,
      public.fx_rate_to_eur(p.scur, p.sd) as srate
    from pick p
  )
  select
    priced.k, priced.ky, priced.nm, priced.q,
    case when priced.erate is null or priced.srate is null then null else priced.sd end,
    priced.sp * priced.srate,
    case when priced.erate is null or priced.srate is null then null else priced.ed end,
    priced.ep * priced.erate,
    case
      when priced.ed is null or priced.erate is null or priced.srate is null then 'no_price'
      when priced.is_since then 'since'
      when priced.ed < max(priced.ed) over () - 3 then 'stale' -- stopped updating
      when not p_last_move and least(p_from, priced.ed) - priced.sd > 7 then 'stale'
      else 'ok'
    end
  from priced
  order by priced.k, priced.ky;
end;
$$;

comment on table public.price_history is
  'Deprecated: nothing writes or reads it since 20270107000000. Kept so no data is lost; a later release drops it.';
