-- Back to the 20261213000000 definition (no cleanup on an account switch).
create or replace function public.splitwise_save_connection(
  p_user uuid, p_key text, p_splitwise_user_id bigint, p_display_name text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
  v_name text := 'splitwise_api_key:' || p_user::text;
begin
  if p_user is null or p_splitwise_user_id is null then raise exception 'Missing user'; end if;
  if p_key is null or char_length(p_key) not between 1 and 500 then raise exception 'Missing API key'; end if;
  select key_secret_id into v_secret from public.splitwise_connections where user_id = p_user for update;
  if v_secret is not null and exists (select 1 from vault.secrets where id = v_secret) then
    perform vault.update_secret(v_secret, p_key);
  else
    delete from vault.secrets where name = v_name;
    v_secret := vault.create_secret(p_key, v_name, 'Splitwise API key, read only by the sync-splitwise Edge Function');
  end if;
  insert into public.splitwise_connections (user_id, splitwise_user_id, display_name, key_secret_id, status, consent_at)
  values (p_user, p_splitwise_user_id, left(p_display_name, 200), v_secret, 'ok', now())
  on conflict (user_id) do update
    set cursor_updated_at = case when splitwise_connections.splitwise_user_id = excluded.splitwise_user_id
                                 then splitwise_connections.cursor_updated_at end,
        last_full_check_at = case when splitwise_connections.splitwise_user_id = excluded.splitwise_user_id
                                  then splitwise_connections.last_full_check_at end,
        splitwise_user_id = excluded.splitwise_user_id,
        display_name = excluded.display_name,
        key_secret_id = excluded.key_secret_id,
        status = 'ok',
        last_error = null,
        consent_at = excluded.consent_at;
  -- A new key starts fresh: a run refused for the old one must not hold back the first sync with
  -- this one ("Synced a moment ago"). Connect tries keep counting (they limit this call).
  delete from public.splitwise_attempts where user_id = p_user and kind in ('sync', 'preview');
end;
$$;
