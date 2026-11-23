-- H018: a browser's push endpoint belongs to whoever signed in last on it.
-- The plain insert failed on the unique endpoint once another account had
-- subscribed this browser, so the new user never got notifications and the
-- old one kept receiving them. This takes the endpoint over for the caller.
create or replace function public.claim_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_endpoint is null or length(p_endpoint) > 2048 or p_endpoint !~ '^https://' then
    raise exception 'invalid push endpoint' using errcode = '22023';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth);
end
$$;

revoke all on function public.claim_push_subscription(text, text, text) from public, anon;
grant execute on function public.claim_push_subscription(text, text, text) to authenticated;
