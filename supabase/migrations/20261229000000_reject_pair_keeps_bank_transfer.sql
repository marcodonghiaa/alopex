-- Rejecting a suggested transfer pair no longer turns its bank-coded side into spending or
-- income. Post-sync may pair a currency exchange or wallet top-up (already a transfer from the
-- bank code, flow_source 'bank') with an unrelated row of the same amount; rejecting that pair
-- made both rows spend/income for good. Now only the side post-sync paired ('pair') goes back to
-- its direction; a 'bank' side stays transfer/bank. Confirming is unchanged, and so is the stale
-- check (both sides must still be as post-sync left them). Same signature: grants are kept.

create or replace function public.resolve_transfer_pair(p_pair uuid, p_keep boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_pair public.transfer_pairs;
  v_rows int;
begin
  if p_keep is null then
    raise exception 'p_keep is required';
  end if;
  select * into v_pair from public.transfer_pairs
   where id = p_pair and user_id = auth.uid()
   for update;
  if not found then
    raise exception 'Transfer pair not found';
  end if;
  if v_pair.status <> 'suggested' then
    raise exception 'Transfer pair already %', v_pair.status;
  end if;

  update public.transfer_pairs set status = case when p_keep then 'confirmed' else 'rejected' end
   where id = p_pair;

  perform 1 from public.transactions t
   where t.user_id = v_pair.user_id
     and t.flow_source in ('pair', 'bank')
     and t.deleted_at is null
     and ((t.account_uid = v_pair.out_account_uid and t.entry_reference = v_pair.out_ref)
       or (t.account_uid = v_pair.in_account_uid and t.entry_reference = v_pair.in_ref))
     for update;
  get diagnostics v_rows = row_count;
  if v_rows <> 2 then
    raise exception 'Transfer pair is stale: a transaction changed since it was suggested';
  end if;

  -- Rejecting: only a side post-sync paired goes back to its direction. A 'bank' side (EXCHANGE,
  -- TOPUP) was a transfer before the pair was suggested and stays one.
  update public.transactions t
     set flow_type = case
           when p_keep then 'transfer'
           when t.credit_debit_indicator = 'DBIT' then 'spend'
           else 'income'
         end,
         flow_source = 'user'
   where t.user_id = v_pair.user_id
     and t.flow_source in ('pair', 'bank')
     and (p_keep or t.flow_source = 'pair')
     and t.deleted_at is null
     and ((t.account_uid = v_pair.out_account_uid and t.entry_reference = v_pair.out_ref)
       or (t.account_uid = v_pair.in_account_uid and t.entry_reference = v_pair.in_ref));
end;
$$;
