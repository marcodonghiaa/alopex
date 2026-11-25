-- H237: claim_push_subscription (20261231000000) checks the endpoint and keys, but a direct insert,
-- still allowed so older dashboards keep working, skipped those checks: a signed-in user could
-- store an endpoint like http://192.168.1.1/ and the notify job would POST to it from the server.
-- The table now has the same rules, plus a host check: an https endpoint of at most 2048
-- characters whose host is a DNS name (letters, digits and hyphens, at least one dot), never an IP
-- literal (v4 in any form, or bracketed v6), localhost or *.localhost, and never with user info;
-- and base64url keys of at most 256. The claim RPC inserts into this table, so it refuses the same.
-- A DNS name that resolves to a private address still passes: the check can't see DNS.
-- A row that breaks them can never get a push (browsers only hand out https endpoints on the push
-- services' DNS names and base64url keys), so it is deleted first; that user only has to turn
-- check-ins on again. Then the check is validated (the table is small).
create or replace function public.push_endpoint_ok(p_endpoint text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_endpoint ~ '^https://' and char_length(p_endpoint) <= 2048
    -- host[:port], without user info: labels of letters, digits and hyphens, at least one dot
    and h ~ '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\.?$'
    and rtrim(lower(h), '.') !~ '(^|\.)localhost$'
    -- a numeric (or 0x) last label makes the whole host an IPv4 address to URL parsers
    and substring(rtrim(lower(h), '.') from '([^.]*)$') !~ '^([0-9]+|0x[0-9a-f]*)$',
    false)
  from (select regexp_replace(substring(p_endpoint from '^https://([^/?#]*)'), ':[0-9]{1,5}$', '') as h) x
$$;

delete from public.push_subscriptions
where not (public.push_endpoint_ok(endpoint)
  and char_length(p256dh) <= 256 and p256dh ~ '^[A-Za-z0-9_-]+=*$'
  and char_length(auth) <= 256 and auth ~ '^[A-Za-z0-9_-]+=*$');
alter table public.push_subscriptions drop constraint if exists push_subscriptions_valid;
alter table public.push_subscriptions add constraint push_subscriptions_valid
  check (public.push_endpoint_ok(endpoint)
    and char_length(p256dh) <= 256 and p256dh ~ '^[A-Za-z0-9_-]+=*$'
    and char_length(auth) <= 256 and auth ~ '^[A-Za-z0-9_-]+=*$') not valid;
alter table public.push_subscriptions validate constraint push_subscriptions_valid;
