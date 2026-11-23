-- Your categories get an icon and a colour, and a category can be removed or renamed without
-- leaving anything behind.
--
-- * user_categories.icon / color: names from the dashboard's icon set and colour palette (not
--   SVG or hex: the dashboard draws them, so they follow light and dark mode). Null = default.
--   A built-in category can carry a row too, to change its icon or colour. Colour names:
--   pink violet indigo orange blue teal yellow cyan lime fuchsia slate brown gray red green.
-- * move_category(from, to): moves everything filed under `from` (transactions, rules,
--   subscriptions, Splitwise shares, budgets, imported spend history) to `to`, then removes
--   `from` (your own: deleted; built-in: hidden). Deleting a category always goes through it, so
--   no transaction is left on a category that no longer exists. When `to` doesn't exist yet it
--   is created with `from`'s icon and colour: that is a rename.

alter table public.user_categories
  add column if not exists icon text
    check (icon is null or icon ~ '^[a-z][a-z0-9-]{0,39}$'),
  add column if not exists color text
    check (color is null or color ~ '^[a-z][a-z0-9-]{0,19}$');

create or replace function public.move_category(p_from text, p_to text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  builtin constant text[] := array[
    'Shopping', 'Entertainment', 'Groceries', 'Dine Out', 'Services', 'Housing', 'Transports',
    'Experiences', 'Income', 'Health', 'Transfer', 'Taxes', 'Others'];
  src public.user_categories;
  target text;
  target_hidden boolean;
  moved integer;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  p_from := btrim(p_from);
  p_to := btrim(regexp_replace(coalesce(p_to, ''), '\s+', ' ', 'g'));
  if coalesce(p_from, '') = '' or p_to = '' then
    raise exception 'Pick the category to move to' using errcode = '22023';
  end if;
  if char_length(p_to) > 40 then
    raise exception 'At most 40 characters' using errcode = '22023';
  end if;
  if p_from in ('Transfer', 'Income') then
    raise exception 'Transfer and Income can''t be removed: transfers and income depend on them'
      using errcode = '22023';
  end if;

  -- One move per user at a time, so two tabs can't interleave.
  perform pg_advisory_xact_lock(hashtext('move_category:' || uid::text));

  select * into src from public.user_categories where user_id = uid and name = p_from;
  if not (p_from = any(builtin)) and src.name is null then
    raise exception '"%" is not one of your categories', p_from using errcode = '22023';
  end if;

  -- The target, matched without case ("holiday" finds "Holiday"); a case-only rename of your own
  -- category keeps the new spelling.
  select c.name, c.hidden into target, target_hidden
    from (
      select b as name, coalesce((select u.hidden from public.user_categories u
                                   where u.user_id = uid and u.name = b), false) as hidden
        from unnest(builtin) b
      union all
      select u.name, u.hidden from public.user_categories u
       where u.user_id = uid and not (u.name = any(builtin))
    ) c
   where lower(c.name) = lower(p_to) and c.name <> p_from
   limit 1;

  if target is null then
    if p_to = p_from then
      raise exception 'Pick a different category' using errcode = '22023';
    end if;
    -- A new name: create it, keeping the look of the one it replaces (a built-in one's default
    -- icon and colour when you never changed them).
    target := p_to;
    insert into public.user_categories (user_id, name, icon, color)
    values (uid, target,
            coalesce(src.icon, case when p_from = any(builtin) then lower(replace(p_from, ' ', '-')) end),
            coalesce(src.color, case p_from
              when 'Shopping' then 'pink' when 'Entertainment' then 'violet'
              when 'Groceries' then 'indigo' when 'Dine Out' then 'orange'
              when 'Services' then 'blue' when 'Housing' then 'teal'
              when 'Transports' then 'yellow' when 'Experiences' then 'cyan'
              when 'Health' then 'fuchsia' when 'Taxes' then 'brown'
              when 'Others' then 'gray' end));
  elsif target_hidden then
    raise exception '"%" is hidden: show it first, or pick another category', target
      using errcode = '22023';
  end if;

  update public.transactions set category = target where user_id = uid and category = p_from;
  get diagnostics moved = row_count;
  update public.category_rules set set_category = target where user_id = uid and set_category = p_from;
  update public.recurring_streams set category = target where user_id = uid and category = p_from;
  update public.splitwise_expenses set category = target where user_id = uid and category = p_from;

  -- Budgets: a month the target already has a budget for keeps the target's.
  insert into public.category_budgets (user_id, category, month, amount, rollover)
  select user_id, target, month, amount, rollover
    from public.category_budgets where user_id = uid and category = p_from
  on conflict (user_id, category, month) do nothing;
  delete from public.category_budgets where user_id = uid and category = p_from;

  -- Imported spend history: the two add up.
  insert into public.spend_history (user_id, month, category, spend_eur)
  select user_id, month, target, spend_eur
    from public.spend_history where user_id = uid and category = p_from
  on conflict (user_id, month, category)
    do update set spend_eur = public.spend_history.spend_eur + excluded.spend_eur;
  delete from public.spend_history where user_id = uid and category = p_from;

  if p_from = any(builtin) then
    insert into public.user_categories (user_id, name, hidden) values (uid, p_from, true)
    on conflict (user_id, name) do update set hidden = true;
  else
    delete from public.user_categories where user_id = uid and name = p_from;
  end if;

  return moved;
end;
$$;

revoke all on function public.move_category(text, text) from public, anon;
grant execute on function public.move_category(text, text) to authenticated;
