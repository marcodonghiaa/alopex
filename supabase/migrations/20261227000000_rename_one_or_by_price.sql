-- Renaming one transaction no longer has to rename every row with the same bank name:
-- 1. p_only_this renames just the clicked row (no alias, so future rows are not touched).
-- 2. Apple, PayPal and Google bill unrelated services under one name ("Apple.com" is iCloud and
--    Apple Music alike), so an alias there is tied to the clicked row's price: rows within 10%
--    of it, past and future. Same price rule as Subscriptions, which splits these by amount.

alter table public.merchant_aliases add column amount numeric check (amount is null or amount > 0);
-- One alias per name per price; a price-less alias is the name's alias for every price.
alter table public.merchant_aliases drop constraint merchant_aliases_pkey;
alter table public.merchant_aliases
  add constraint merchant_aliases_user_source_amount_key unique nulls not distinct (user_id, source_name, amount);

-- New rows take the alias of their exact name (the one priced closest to them first, then the
-- price-less one), else the newest price-less alias for their key.
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

drop function public.rename_merchant(text, uuid, text);

-- Rename (or clear, when p_name is null/blank) from one transaction. Returns rows changed.
-- p_only_this: just this row. Otherwise the clicked name's rows (an aggregator's: at this price)
-- and the key's unnamed rows, and the alias for future rows. Rows renamed by hand to something
-- else are left alone. Invoker rights: RLS keeps this to the caller's data.
-- Clearing an aggregator's price drops its priced alias only: a price-less alias set before
-- prices existed still names future rows at that price.
create function public.rename_merchant(
  p_entry_reference text, p_account_uid uuid, p_name text, p_only_this boolean default false
) returns integer
language plpgsql set search_path = public as $$
declare
  v_source text;
  v_key text;
  v_price numeric;
  v_old text;
  v_new text := nullif(btrim(p_name), '');
  v_count integer;
begin
  select creditor_name, merchant_key, amount into v_source, v_key, v_price from transactions
  where entry_reference = p_entry_reference
    and account_uid is not distinct from p_account_uid;
  if v_key in ('paypal', 'apple', 'google') then
    -- An aggregator key spans unrelated payees: rename by exact name and price instead.
    v_key := null;
    v_price := nullif(abs(v_price), 0);
  else
    v_price := null;
  end if;
  if v_source is null or p_only_this then
    update transactions set custom_name = v_new
    where entry_reference = p_entry_reference
      and account_uid is not distinct from p_account_uid;
    get diagnostics v_count = row_count;
    return v_count;
  end if;

  -- The alias this row's siblings carry now: its own name's first, at its price first.
  select alias into v_old from merchant_aliases
  where user_id = auth.uid() and (merchant_key = v_key or source_name = v_source)
    and (amount is null or abs(v_price - amount) <= amount * 0.1)
  order by (source_name = v_source) desc, amount is null, created_at desc, source_name
  limit 1;

  -- Replace this name's alias at this price (aggregator) or for every price (anything else).
  delete from merchant_aliases
  where user_id = auth.uid() and source_name = v_source
    and (case when v_price is null then amount is null else abs(v_price - amount) <= amount * 0.1 end);
  if v_new is not null then
    insert into merchant_aliases (user_id, source_name, alias, merchant_key, amount)
    values (auth.uid(), v_source, v_new, v_key, v_price);
  end if;

  -- Other names on the key change only while unnamed, so their own aliases stay on their rows.
  update transactions set custom_name = v_new
  where (creditor_name = v_source and (custom_name is null or custom_name = v_old)
         and (v_price is null or abs(abs(amount) - v_price) <= v_price * 0.1))
     or (v_key is not null and merchant_key = v_key and custom_name is null)
     or (entry_reference = p_entry_reference and account_uid is not distinct from p_account_uid);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.rename_merchant(text, uuid, text, boolean) from public, anon;
grant execute on function public.rename_merchant(text, uuid, text, boolean) to authenticated;
