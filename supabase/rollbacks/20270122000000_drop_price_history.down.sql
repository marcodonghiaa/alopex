-- Rollback of 20270122000000_drop_price_history: the table comes back empty (the dropped rows
-- are gone), with the same policy and grants as 20261107000000 and its deprecated comment.
create table if not exists public.price_history (
  provider text not null check (provider in ('yahoo', 'coingecko')),
  symbol text not null check (char_length(symbol) between 1 and 100),
  price_date date not null,
  price numeric not null check (price > 0),
  currency text not null check (char_length(currency) between 1 and 10),
  fetched_at timestamptz not null default now(),
  primary key (provider, symbol, price_date)
);

alter table public.price_history enable row level security;
drop policy if exists "Authenticated users can view price history" on public.price_history;
create policy "Authenticated users can view price history" on public.price_history
  for select to authenticated using (true);
revoke all on public.price_history from anon;
revoke insert, update, delete, truncate, references, trigger on public.price_history from authenticated;
grant select on public.price_history to authenticated;
grant select, insert, update, delete on public.price_history to service_role;

comment on table public.price_history is
  'Deprecated: nothing writes or reads it since 20270107000000. Kept so no data is lost; a later release drops it.';
