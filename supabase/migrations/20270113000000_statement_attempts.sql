-- H241: parse-statement claims an attempt before each Gemini call, so a signed-in user (or a
-- stolen token) can't loop PDFs into the owner's Gemini quota. It reuses splitwise_attempts and
-- splitwise_attempt (server-only, service role) with a new kind, 'statement'. The new check is a
-- superset of the old one, so every existing row passes it.
alter table public.splitwise_attempts drop constraint if exists splitwise_attempts_kind_check;
alter table public.splitwise_attempts add constraint splitwise_attempts_kind_check
  check (kind in ('sync', 'preview', 'connect', 'statement'));
