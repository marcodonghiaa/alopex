# Contributing

This is a solo-maintained project — PRs and issues are welcome, response time varies.

## Before opening a PR

1. Run `npm test` (set `RLS_TEST_DATABASE_URL` to a throwaway Postgres to include the database tests) and, for Edge Function changes, `deno test` as in `.github/workflows/test.yml`. CI runs both.
2. For schema changes, add a new file under `supabase/migrations/`, never edit an existing one.
3. Keep PRs scoped to one change — easier to review, easier to revert if something breaks.

## Reporting bugs / security issues

- Regular bugs: open a GitHub issue with the bug report template.
- Anything touching real financial data, secrets, or auth: email the maintainer directly instead of opening a public issue.
