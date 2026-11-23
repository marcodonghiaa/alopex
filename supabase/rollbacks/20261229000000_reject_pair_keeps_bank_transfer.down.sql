-- Restores resolve_transfer_pair from 20261128000000: rejecting a pair puts both sides back to spend or income.

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

  update public.transactions t
     set flow_type = case
           when p_keep then 'transfer'
           when t.credit_debit_indicator = 'DBIT' then 'spend'
           else 'income'
         end,
         flow_source = 'user'
   where t.user_id = v_pair.user_id
     and t.flow_source in ('pair', 'bank')
     and t.deleted_at is null
     and ((t.account_uid = v_pair.out_account_uid and t.entry_reference = v_pair.out_ref)
       or (t.account_uid = v_pair.in_account_uid and t.entry_reference = v_pair.in_ref));
  get diagnostics v_rows = row_count;
  if v_rows <> 2 then
    raise exception 'Transfer pair is stale: a transaction changed since it was suggested';
  end if;
end;
$$;
