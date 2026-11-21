-- Subscriptions follow your transaction edits (thread "Sync transaction edits to subscriptions").
-- A stream you confirmed or dismissed used to stay forever as it was last detected, even after a run
-- no longer found it (its charge marked One-time, moved to Transfer, deleted). Such a row is now marked
-- 'gone': the dashboard hides it, and it keeps your choices (confirmed, cadence), which come back if a
-- later run finds it again. Undecided rows are still deleted, and an imported override that was never
-- detected (detected_status null) is left alone.

alter table public.recurring_streams drop constraint if exists recurring_streams_detected_status_check;
alter table public.recurring_streams add constraint recurring_streams_detected_status_check
  check (detected_status in ('suggested', 'active', 'gone'));

create or replace function public.upsert_detected_streams(p_user uuid, p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  insert into public.recurring_streams (
    user_id, stream_key, merchant_key, account_uid, currency, display_name, category, cadence,
    typical_amount, typical_amount_eur, charge_count, first_charged, last_charged, next_expected,
    detected_status, is_direct_debit, detected_at)
  select p_user, r.stream_key, r.merchant_key, r.account_uid, r.currency, r.display_name, r.category, r.cadence,
    r.typical_amount, r.typical_amount_eur, r.charge_count, r.first_charged, r.last_charged, r.next_expected,
    r.detected_status, r.is_direct_debit, now()
  from jsonb_populate_recordset(null::public.recurring_streams, p_rows) r
  on conflict (user_id, stream_key) do update set
    merchant_key = excluded.merchant_key,
    account_uid = excluded.account_uid,
    currency = excluded.currency,
    display_name = excluded.display_name,
    category = excluded.category,
    cadence = excluded.cadence,
    typical_amount = excluded.typical_amount,
    typical_amount_eur = excluded.typical_amount_eur,
    charge_count = excluded.charge_count,
    first_charged = excluded.first_charged,
    last_charged = excluded.last_charged,
    next_expected = excluded.next_expected,
    detected_status = excluded.detected_status,
    is_direct_debit = excluded.is_direct_debit,
    detected_at = excluded.detected_at;
  get diagnostics v_count = row_count;
  -- Stale detector-only rows (no user choice, not imported) that this run no longer finds go away.
  delete from public.recurring_streams s
  where s.user_id = p_user and s.user_status is null and s.source = 'bank'
    and not exists (select 1 from jsonb_array_elements(p_rows) e where e->>'stream_key' = s.stream_key);
  -- Rows you decided on that this run no longer finds are kept, marked gone (see the top of this file).
  update public.recurring_streams s set detected_status = 'gone', detected_at = now()
  where s.user_id = p_user and s.detected_status in ('suggested', 'active')
    and not exists (select 1 from jsonb_array_elements(p_rows) e where e->>'stream_key' = s.stream_key);
  return v_count;
end;
$$;
revoke execute on function public.upsert_detected_streams(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_detected_streams(uuid, jsonb) to service_role;
