-- Rollback of 20270113000000_statement_attempts: statement attempts are dropped and the kinds are
-- as in 20261213000000_splitwise_api_sync. Deploy the previous parse-statement first, or every
-- PDF import answers 503.
delete from public.splitwise_attempts where kind = 'statement';
alter table public.splitwise_attempts drop constraint if exists splitwise_attempts_kind_check;
alter table public.splitwise_attempts add constraint splitwise_attempts_kind_check
  check (kind in ('sync', 'preview', 'connect'));
