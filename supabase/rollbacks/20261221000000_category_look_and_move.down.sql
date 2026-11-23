-- Rollback of 20261221000000_category_look_and_move: your categories lose their icon and colour
-- (they show their first letter again) and deleting one leaves its transactions as they are.
drop function if exists public.move_category(text, text);
alter table public.user_categories drop column if exists icon, drop column if exists color;
