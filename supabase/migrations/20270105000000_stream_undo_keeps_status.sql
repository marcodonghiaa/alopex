-- Undo or Restore of a removed subscription puts back what it was. Before, undismiss set
-- user_status to null whenever the detector had a status, so a stream you had confirmed came back
-- as "To review" (or in no list at all, when that suggestion was stale). dismiss now remembers the
-- status in prev_user_status and undismiss restores it. Also moves stream_action to an empty
-- search_path (every name in it was already qualified).
alter table public.recurring_streams
  add column if not exists prev_user_status text check (prev_user_status in ('confirmed'));

create or replace function public.stream_action(p_stream uuid, p_action text, p_args jsonb default '{}')
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.recurring_streams where id = p_stream and user_id = auth.uid()) then
    raise exception 'Stream not found';
  end if;
  if p_action = 'confirm' then
    update public.recurring_streams set user_status = 'confirmed', updated_at = now() where id = p_stream;
  elsif p_action = 'dismiss' then
    -- Remember what it was (a second remove keeps the first answer), for Undo and Restore.
    update public.recurring_streams
    set prev_user_status = case when user_status = 'dismissed' then prev_user_status else user_status end,
        user_status = 'dismissed', updated_at = now()
    where id = p_stream;
  elsif p_action = 'undismiss' then
    -- Back to what it was before the remove. Without a remembered status (removed before this
    -- migration): a row the detector never filled (an imported override) would vanish from every
    -- list as undecided, so it is confirmed.
    update public.recurring_streams
    set user_status = coalesce(prev_user_status, case when detected_status is null then 'confirmed' end),
        prev_user_status = null, updated_at = now()
    where id = p_stream;
  elsif p_action = 'set_cadence' then
    if p_args ? 'cadence' then
      update public.recurring_streams
      set user_cadence = p_args->>'cadence', custom_interval_value = null, custom_interval_unit = null,
          user_status = 'confirmed', updated_at = now()
      where id = p_stream;
    elsif (p_args->>'custom_value')::int > 0 and p_args->>'custom_unit' is not null then
      update public.recurring_streams
      set user_cadence = 'custom', custom_interval_value = (p_args->>'custom_value')::int,
          custom_interval_unit = p_args->>'custom_unit', user_status = 'confirmed', updated_at = now()
      where id = p_stream;
    else
      raise exception 'Invalid cadence args';
    end if;
  else
    raise exception 'Unknown stream action: %', p_action;
  end if;
end;
$$;
revoke execute on function public.stream_action(uuid, text, jsonb) from public, anon;
grant execute on function public.stream_action(uuid, text, jsonb) to authenticated;
