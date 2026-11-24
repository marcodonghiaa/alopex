-- H237: claim_push_subscription (20261231000000) checks the endpoint and keys, but a direct insert,
-- still allowed so older dashboards keep working, skipped those checks: a signed-in user could
-- store an endpoint like http://192.168.1.1/ and the notify job would POST to it from the server.
-- The table now has the same rules: an https endpoint of at most 2048 characters and base64url
-- keys of at most 256. A row that breaks them can never get a push (browsers only hand out https
-- endpoints and base64url keys), so it is deleted first; that user only has to turn check-ins on
-- again. Then the check is validated (the table is small).
delete from public.push_subscriptions
where not (endpoint ~ '^https://' and char_length(endpoint) <= 2048
  and char_length(p256dh) <= 256 and p256dh ~ '^[A-Za-z0-9_-]+=*$'
  and char_length(auth) <= 256 and auth ~ '^[A-Za-z0-9_-]+=*$');
alter table public.push_subscriptions drop constraint if exists push_subscriptions_valid;
alter table public.push_subscriptions add constraint push_subscriptions_valid
  check (endpoint ~ '^https://' and char_length(endpoint) <= 2048
    and char_length(p256dh) <= 256 and p256dh ~ '^[A-Za-z0-9_-]+=*$'
    and char_length(auth) <= 256 and auth ~ '^[A-Za-z0-9_-]+=*$') not valid;
alter table public.push_subscriptions validate constraint push_subscriptions_valid;
