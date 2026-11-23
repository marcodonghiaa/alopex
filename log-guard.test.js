const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

// Logs may hold counts, positions, status codes, error codes/names and fixed text, never personal
// data. A line-based backstop, not a proof: a renamed variable slips past it.

const CONSOLE_CALL = /console\.(log|error|warn|info)\(.*/;
// Stripped before the checks: the allowed forms that would otherwise look like a leak.
const ALLOWED = /\b(err|error)\.name\b|\btotal(Categorized|Classified)\b|JSON\.stringify\(result\)/g;
const LEAKS = [
  /\$\{[^}]*(\bname\b|label|creditor_name|debtor_name|amount|shares|balance|price|value|total|iban|message|\bdescription\b|\bremittance\b|\bentry_reference\b|\buser_id\b)[^}]*\}/,
  /JSON\.stringify/,
  /\.(details|hint|message)\b|\.text\(\)/,
  /, (err|error|row|rows|data|tx|account|holding)\)/,
  /^console\.\w+\((err|error)\)/,
];

// The bank sync, run by pg_cron, plus the functions that touch bank links, holdings
// and statements: counts and codes only, same rules. Their logs are the project's private Supabase
// logs, but an error message can still quote a database row or a bank's reply, so none is logged.
const ERROR_TAG_ONLY_PATHS = [
  'supabase/functions/_shared/bank-sync.ts',
  'supabase/functions/_shared/transfer-pairs.ts',
  'supabase/functions/sync-bank/index.ts',
  'supabase/functions/bank-consent-callback/index.ts',
  'supabase/functions/complete-bank-consent/index.ts',
  'supabase/functions/delete-account/index.ts',
  'supabase/functions/_shared/link-accounts.ts',
  'supabase/functions/_shared/first-sync.ts',
  'supabase/functions/_shared/eb-sessions.ts',
  'supabase/functions/add-holding/index.ts',
  'supabase/functions/parse-statement/index.ts',
  'supabase/functions/reapply-rules/handler.ts',
  'supabase/functions/refresh-recurring/handler.ts',
  'supabase/functions/_shared/caller.ts',
  'supabase/functions/_shared/splitwise-api.ts',
  'supabase/functions/_shared/splitwise-sync.ts',
  'supabase/functions/_shared/splitwise-sync-job.ts',
  'supabase/functions/sync-splitwise/index.ts',
  'supabase/functions/_shared/splitwise-connect.ts',
  'supabase/functions/splitwise-connect/index.ts',
];

function leakyLines(file) {
  const offenders = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const call = line.match(CONSOLE_CALL)?.[0].replace(ALLOWED, '');
    if (call && LEAKS.some((re) => re.test(call))) offenders.push(`${file}:${i + 1}`);
  });
  return offenders;
}

test('the Edge Function sync paths log no personal data, raw responses or error messages', () => {
  assert.deepStrictEqual(ERROR_TAG_ONLY_PATHS.flatMap(leakyLines), []);
});
