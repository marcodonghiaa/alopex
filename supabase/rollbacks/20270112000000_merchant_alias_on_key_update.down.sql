-- Rollback of 20270112000000_merchant_alias_on_key_update: the alias trigger runs on insert only
-- and apply_merchant_alias is as in 20261227000000_rename_one_or_by_price. Roll the Edge Functions
-- back too (post-sync's backfill wrote the alias itself before), or keyed rows stay unnamed.
create or replace function public.apply_merchant_alias() returns trigger
language plpgsql security definer set search_path = public as $$
begin
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
  before insert on public.transactions
  for each row execute function public.apply_merchant_alias();
