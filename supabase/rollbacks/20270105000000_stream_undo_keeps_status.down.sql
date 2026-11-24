-- Rollback of 20270105000000_stream_undo_keeps_status: stream_action as in
-- 20261121000000_recurring_streams_v2 (Undo of a removed stream no longer restores a confirmed
-- status), and the remembered status is dropped.
create or replace function public.stream_action(p_stream uuid, p_action text, p_args jsonb default '{}')
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.recurring_streams where id = p_stream and user_id = auth.uid()) then
    raise exception 'Stream not found';
  end if;
  if p_action = 'confirm' then
    update public.recurring_streams set user_status = 'confirmed', updated_at = now() where id = p_stream;
  elsif p_action = 'dismiss' then
    update public.recurring_streams set user_status = 'dismissed', updated_at = now() where id = p_stream;
  elsif p_action = 'undismiss' then
    -- A row the detector never filled (an imported override) would vanish from every list as undecided.
    update public.recurring_streams
    set user_status = case when detected_status is null then 'confirmed' end, updated_at = now()
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

alter table public.recurring_streams drop column if exists prev_user_status;
