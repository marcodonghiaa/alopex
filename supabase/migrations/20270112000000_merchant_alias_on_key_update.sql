-- The merchant alias is chosen here only. The post-sync backfill sets merchant_key on rows stored
-- before the sync wrote it, and used to repeat this lookup in TypeScript; the trigger now also runs
-- when a row's merchant_key is set or changed, so the backfill writes the key alone.
-- apply_merchant_alias as in 20261227000000_rename_one_or_by_price, with an empty search_path.
-- An update that keeps or clears the key (a re-sync, a user unlinking a merchant) renames nothing.
create or replace function public.apply_merchant_alias() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.merchant_key is null or new.merchant_key is not distinct from old.merchant_key) then
    return new;
  end if;
  if new.custom_name is null and new.creditor_name is not null then
    select alias into new.custom_name
    from public.merchant_aliases
    where user_id = new.user_id and source_name = new.creditor_name
      and (amount is null or abs(new.amount - amount) <= amount * 0.1)
    order by amount is null, abs(new.amount - amount)
    limit 1;
    -- Aggregator keys (PayPal, Apple, Google) cover unrelated payees, so they match by name only.
    if new.custom_name is null and new.merchant_key is not null and new.merchant_key not in ('paypal', 'apple', 'google') then
      select alias into new.custom_name
      from public.merchant_aliases
      where user_id = new.user_id and merchant_key = new.merchant_key and amount is null
      order by created_at desc, source_name
      limit 1;
    end if;
  end if;
  return new;
end;
$$;

drop trigger trg_apply_merchant_alias on public.transactions;
create trigger trg_apply_merchant_alias
  before insert or update of merchant_key on public.transactions
  for each row execute function public.apply_merchant_alias();
