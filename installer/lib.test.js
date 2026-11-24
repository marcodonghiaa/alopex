const test = require('node:test');
const assert = require('node:assert');
const lib = require('./lib');
const path = require('node:path');

test('refFromUrl reads the project ref, rejects anything else', () => {
  assert.equal(lib.refFromUrl('https://abcdefghijklmnopqrst.supabase.co'), 'abcdefghijklmnopqrst');
  assert.equal(lib.refFromUrl('https://abc.supabase.co/'), 'abc');
  assert.equal(lib.refFromUrl('https://evil.com/abc.supabase.co'), '');
  assert.equal(lib.refFromUrl(undefined), '');
});

// H006: re-running against another project must create the login there, or closing sign-ups locks the
// owner out. The old login is forgotten as soon as the new project is saved, so a run stopped before the
// login step (the next run then sees the new project as "last run's") still creates it.
test('projectEnv: a new project forgets the old login, the same project keeps it', () => {
  const url = 'https://xyz.supabase.co';
  assert.deepEqual(lib.projectEnv('abc', 'xyz', url), { SUPABASE_URL: url, USER_ID: '', LOGIN_EMAIL: '' });
  assert.deepEqual(lib.projectEnv('', 'xyz', url), { SUPABASE_URL: url, USER_ID: '', LOGIN_EMAIL: '' });
  assert.deepEqual(lib.projectEnv('xyz', 'xyz', url), { SUPABASE_URL: url });
});

test('pickKeys matches by prefix, not position', () => {
  const keys = [{ api_key: 'eyJlegacy' }, { api_key: 'sb_secret_x' }, { api_key: 'sb_publishable_y' }];
  assert.deepEqual(lib.pickKeys(keys), { publishable: 'sb_publishable_y', secret: 'sb_secret_x', cron: 'sb_secret_x' });
  assert.deepEqual(lib.pickKeys([{ api_key: 'eyJ' }]), { publishable: '', secret: '', cron: '' });
});

// H212: the scheduled sync's key sits in Vault and in pg_net's queue: a secret key named "cron", when
// the owner made one, goes there instead of the main one, so it can be revoked on its own. The
// main key stays the one .env and the functions use. fails_when=Vault gets the main key while a
// "cron" key exists, or no key at all without one
test('pickKeys gives the scheduled sync a secret key named cron, else the main one', () => {
  const keys = [
    { name: 'default', type: 'secret', api_key: 'sb_secret_main' },
    { name: 'cron', type: 'secret', api_key: 'sb_secret_cron' },
    { name: 'default', type: 'publishable', api_key: 'sb_publishable_y' },
  ];
  assert.deepEqual(lib.pickKeys(keys), { publishable: 'sb_publishable_y', secret: 'sb_secret_main', cron: 'sb_secret_cron' });
  // Named cron but not a secret key: ignored.
  assert.equal(lib.pickKeys([{ name: 'cron', api_key: 'sb_publishable_z' }, { api_key: 'sb_secret_main' }]).cron, 'sb_secret_main');
  const src = require('node:fs').readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /sync_bank_secret_key: keys\.cron/);
});

test('vaultSql updates an existing secret or creates it, and escapes quotes', () => {
  const sql = lib.vaultSql({ project_url: "https://a'b.supabase.co" });
  assert.match(sql, /^do \$\$/);
  assert.match(sql, /vault\.update_secret\(\(select id from vault\.secrets where name = 'project_url'\), 'https:\/\/a''b\.supabase\.co'\)/);
  assert.match(sql, /vault\.create_secret\('https:\/\/a''b\.supabase\.co', 'project_url'\)/);
});

test('authConfigToml closes sign-ups and adds the site URL only when known', () => {
  const plain = lib.authConfigToml();
  assert.match(plain, /enable_signup = false/);
  assert.doesNotMatch(plain, /site_url/);
  // H217: the server refuses a new password under 12 characters too (sign-in with an older,
  // shorter one keeps working: the length is checked only when a password is set). Pushed only
  // when asked (closeAuth asks only to raise it), so a longer remote minimum is never lowered.
  assert.doesNotMatch(plain, /minimum_password_length/);
  assert.match(lib.authConfigToml({ minPassword: 12 }), /^minimum_password_length = 12$/m);
  const withSite = lib.authConfigToml({ siteUrl: 'https://x.vercel.app' });
  assert.match(withSite, /site_url = "https:\/\/x\.vercel\.app"/);
  assert.match(withSite, /additional_redirect_urls = \["https:\/\/x\.vercel\.app\/reset-password"\]/);
});

// H217: `supabase config diff --output-format json` against a config declaring 12. The push must
// only raise the minimum: an owner who set 16 by hand keeps 16. fails_when=a remote 16 reads as
// lower than 12, or an unreadable answer reads as a known length
test('remotePasswordLength reads the project\'s minimum from config diff, null when unknown', () => {
  const diff = (changes, present = ['auth']) => `Target: x\n${JSON.stringify({ scope: { present, missing: [] }, changes })}\n`;
  const len = (remote) => ({ path: ['auth', 'minimum_password_length'], class: 'update', declared: true, local: 12, remote });
  assert.strictEqual(lib.remotePasswordLength(diff([len(16)]), 12), 16);
  assert.strictEqual(lib.remotePasswordLength(diff([len(6), { path: ['auth', 'site_url'], remote: 'https://a' }]), 12), 6);
  // No difference while auth was compared: the project already has the declared 12.
  assert.strictEqual(lib.remotePasswordLength(diff([]), 12), 12);
  // Auth not returned, a non-number, or no JSON: unknown, so nothing is pushed for it.
  assert.strictEqual(lib.remotePasswordLength(diff([], []), 12), null);
  assert.strictEqual(lib.remotePasswordLength(diff([len(null)]), 12), null);
  assert.strictEqual(lib.remotePasswordLength('Error: no access token', 12), null);
  assert.strictEqual(lib.remotePasswordLength('', 12), null);
  // closeAuth reads it first and pushes 12 only when the project's minimum is lower.
  const src = require('node:fs').readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /'config', 'diff'/);
  assert.match(src, /remote !== null && remote < lib\.MIN_PASSWORD \? lib\.MIN_PASSWORD : undefined/);
});

test('vercelUrl prefers the alias, else the last vercel.app address, else empty', () => {
  assert.equal(lib.vercelUrl('Production: https://a-123abc.vercel.app\nAliased: https://a.vercel.app [3s]'), 'https://a.vercel.app');
  assert.equal(lib.vercelUrl('https://a-123abc-me.vercel.app\n'), 'https://a-123abc-me.vercel.app');
  assert.equal(lib.vercelUrl('nothing'), '');
});

test('pickAlias takes the shortest non-branch alias in any shape', () => {
  assert.equal(lib.pickAlias(JSON.stringify({ aliases: ['alopex-ab-git-main-me.vercel.app', 'alopex-ab-me.vercel.app', 'alopex-ab.vercel.app'] })), 'https://alopex-ab.vercel.app');
  assert.equal(lib.pickAlias(JSON.stringify({ alias: [{ domain: 'x.vercel.app' }] })), 'https://x.vercel.app');
  assert.equal(lib.pickAlias(JSON.stringify({})), '');
  assert.equal(lib.pickAlias('not json'), '');
});

test('projectSlug makes a valid Vercel name', () => {
  assert.equal(lib.projectSlug('Alopex-AbC_12'), 'alopex-abc-12');
  assert.equal(lib.projectSlug('***'), 'alopex');
});

test('nodeTooOld', () => {
  assert.equal(lib.nodeTooOld('v18.19.0'), true);
  assert.equal(lib.nodeTooOld('v20.0.0'), false);
  assert.equal(lib.nodeTooOld('v22.11.0'), false);
});

test('tarballUrl points at codeload for a branch', () => {
  assert.equal(lib.tarballUrl('me/repo', 'main'), 'https://codeload.github.com/me/repo/tar.gz/main');
});

test('cleanPath strips quotes and drag-and-drop escapes, expands ~', { skip: process.platform === 'win32' }, () => {
  assert.equal(lib.cleanPath("'/Users/me/My Keys/a.pem'", '/Users/me'), '/Users/me/My Keys/a.pem');
  assert.equal(lib.cleanPath('/Users/me/My\\ Keys/a.pem ', '/Users/me'), '/Users/me/My Keys/a.pem');
  assert.equal(lib.cleanPath('~/Downloads/a.pem', '/Users/me'), '/Users/me/Downloads/a.pem');
});

test('secretsEnv quotes values, keeps the PEM on one line, skips empty ones', () => {
  const out = lib.secretsEnv({ A: 'x"y', PEM: '-----BEGIN-----\nab+c\n-----END-----\n', EMPTY: '', MISSING: undefined });
  assert.equal(out, 'A="x\\"y"\nPEM="-----BEGIN-----\\nab+c\\n-----END-----"\n');
});

test('checkGeminiKey: ok, rejected, outage', async () => {
  const answer = (status) => async () => ({ ok: status === 200, status });
  assert.deepEqual(await lib.checkGeminiKey('k', answer(200)), { ok: true });
  const bad = await lib.checkGeminiKey('k', answer(400));
  assert.equal(bad.ok, false);
  assert.equal(bad.unreachable, undefined);
  assert.equal((await lib.checkGeminiKey('k', answer(503))).unreachable, true);
  assert.equal((await lib.checkGeminiKey('k', async () => { throw new Error('offline'); })).unreachable, true);
});

// #132: `--help` was taken as the folder name and installed into ./--help.
test('parseArgs: help, unknown options and the folder', () => {
  assert.deepEqual(lib.parseArgs([]), { folder: 'alopex' });
  assert.deepEqual(lib.parseArgs(['my-money']), { folder: 'my-money' });
  assert.deepEqual(lib.parseArgs(['--help']), { help: true });
  assert.deepEqual(lib.parseArgs(['-h']), { help: true });
  assert.match(lib.parseArgs(['--yes']).error, /Unknown option --yes/);
  assert.match(lib.parseArgs(['a', 'b']).error, /at most one folder/);
});

// polish-1 B1: a flag after the folder said "Give at most one folder." instead of help.
test('parseArgs: flags count wherever they are', () => {
  assert.deepEqual(lib.parseArgs(['my-money', '--help']), { help: true });
  assert.match(lib.parseArgs(['my-money', '--yes']).error, /Unknown option --yes/);
});

// polish-1 B2/B3: a folder starting with "-" needs a way in, and the refusal says which.
test('parseArgs: -- ends options, and the error shows how to name a "-" folder', () => {
  assert.deepEqual(lib.parseArgs(['--', '-money']), { folder: '-money' });
  assert.deepEqual(lib.parseArgs(['--', '--help']), { folder: '--help' });
  assert.match(lib.parseArgs(['-money']).error, /\.\/-money/);
});

// polish-2 S1: on Windows cmd expands %VAR% in the folder, so tar would unpack somewhere else.
test('parseArgs: refuses a folder with %', () => {
  assert.match(lib.parseArgs(['%USERPROFILE%x']).error, /%/);
  assert.match(lib.parseArgs(['--', 'a%b']).error, /%/);
});

// polish-3 F12: the "./name" hint is for folder-looking words, not for --flags.
test('parseArgs: no folder hint for a --flag', () => {
  assert.doesNotMatch(lib.parseArgs(['--yes']).error, /\.\/--yes/);
  assert.match(lib.parseArgs(['-money']).error, /\.\/-money/);
});

// polish-3 F9: usage lists the options there are.
test('USAGE lists --help and --', () => {
  assert.match(lib.USAGE, /-h, --help/);
  assert.match(lib.USAGE, /--\s/);
});

// polish-3 F11: what main() does with the arguments, before anything is installed.
test('startup: help exits 0, a bad argument exits 1, anything else installs', () => {
  assert.deepEqual(lib.startup(['--help']), { exit: 0, out: lib.USAGE });
  const bad = lib.startup(['--yes']);
  assert.equal(bad.exit, 1);
  assert.match(bad.err, /Unknown option --yes/);
  assert.ok(bad.err.endsWith(lib.USAGE));
  assert.deepEqual(lib.startup(['my-money']), { folder: 'my-money' });
});

// polish-5 I1: `cd alopex && npx create-alopex` to update installed into alopex/alopex, and Enter on
// "Use a project you already have?" made a second Supabase project and Vercel deploy.
// fails_when=run inside an install with no folder, it doesn't update that install
test('installRoot: inside an install with no folder, updates that install', () => {
  const marks = (i) => [path.join(i, 'backend', '.env'), path.join(i, 'backend', 'env-file.js'), path.join(i, 'dashboard', 'package.json')];
  const at = (...installs) => (p) => installs.some((i) => marks(i).includes(p));
  assert.equal(lib.installRoot('alopex', '/home/me/alopex', at('/home/me/alopex')), '/home/me/alopex');
  // Not inside one: the folder as usual.
  assert.equal(lib.installRoot('alopex', '/home/me', at('/home/me/alopex')), path.resolve('/home/me', 'alopex'));
  // A folder of its own name wins, and so does a real install below.
  assert.equal(lib.installRoot('other', '/home/me/alopex', at('/home/me/alopex')), path.resolve('/home/me/alopex', 'other'));
  assert.equal(lib.installRoot('alopex', '/home/me', at('/home/me', '/home/me/alopex')), path.resolve('/home/me', 'alopex'));
  // re-audit: from backend/ or dashboard/ of an install (.env edits), that install too.
  assert.equal(lib.installRoot('alopex', '/home/me/alopex/backend', at('/home/me/alopex')), '/home/me/alopex');
  assert.equal(lib.installRoot('alopex', '/home/me/alopex/dashboard/src', at('/home/me/alopex')), '/home/me/alopex');
  // re-audit round 2: another project with only a backend/.env is not an install.
  const other = (p) => p === path.join('/work/app', 'backend', '.env');
  assert.equal(lib.installRoot('alopex', '/work/app/frontend/src', other), path.resolve('/work/app/frontend/src', 'alopex'));
});

// polish-5 I4: "-x%" was told to write ./-x%, which the % rule then refused.
test('parseArgs: no folder hint for a word the % rule would refuse', () => {
  assert.doesNotMatch(lib.parseArgs(['-x%']).error, /\.\//);
});

test('orgAfterCreate lists the orgs again: create answers in plain text, not JSON (e2e #3)', () => {
  const calls = [];
  const orgs = lib.orgsAfterCreate(
    (args) => {
      calls.push(args[1]);
      return args[1] === 'create' ? 'Created organization: abc\n' : '[{"id":"abc","name":"me\'s org"}]';
    },
    "me's org",
  );
  assert.deepStrictEqual(calls, ['create', 'list']);
  assert.deepStrictEqual(orgs, [{ id: 'abc', name: "me's org" }]);
});

test('loginProblem refuses an empty or malformed email and a short password (e2e #5)', () => {
  assert.match(lib.loginProblem('', 'secret1'), /email/i);
  assert.match(lib.loginProblem('marco', 'secret1'), /email/i);
  // H217: an internet-facing finance login: 12 characters, not Supabase's default 6.
  assert.match(lib.loginProblem('a@b.co', '12345678901'), /12/);
  assert.strictEqual(lib.loginProblem('a@b.co', '123456789012'), null);
  assert.strictEqual(lib.loginProblem(' a@b.co ', '123456789012'), null);
});

test('banner names the installer version, so a user can tell which release runs (e2e #2)', () => {
  assert.match(lib.banner('0.4.1'), /create-alopex 0\.4\.1/);
});

test('intro: an update says it keeps your settings, a first install gives the 30-minute estimate (e2e #19)', () => {
  assert.match(lib.intro('Alopex', true), /^Updating Alopex: keeps your settings/);
  assert.doesNotMatch(lib.intro('Alopex', true), /30 minutes/);
  assert.match(lib.intro('Alopex', false), /about 30 minutes the first time/);
});

test('projectProblem: a project from another Supabase account says to sign in with its owner (e2e #20)', () => {
  const projects = [{ id: 'aaaaaaaaaaaaaaaaaaaa' }, { ref: 'bbbbbbbbbbbbbbbbbbbb' }];
  assert.equal(lib.projectProblem(projects, 'aaaaaaaaaaaaaaaaaaaa'), null);
  assert.equal(lib.projectProblem(projects, 'bbbbbbbbbbbbbbbbbbbb'), null);
  const msg = lib.projectProblem(projects, 'cccccccccccccccccccc');
  assert.match(msg, /cccccccccccccccccccc isn't in the Supabase account you're signed in to/);
  assert.match(msg, /supabase logout/);
  assert.match(lib.projectProblem([], 'cccccccccccccccccccc'), /isn't in the Supabase account/);
});

test('doneLine: an update is ready to use, a first install still connects a bank (e2e #21)', () => {
  assert.equal(lib.doneLine('https://a.vercel.app', 'me@example.com', true), 'Updated! https://a.vercel.app , sign in as me@example.com.');
  assert.match(lib.doneLine('https://a.vercel.app', 'me@example.com', false), /^Done! .*then Accounts -> Connect a bank\.$/);
});

// H214: the release tarball went to a fixed name in the shared temp folder (alopex-<pid>-...), which
// another local user could pre-create as a symlink, and npm ran the backend packages' install
// scripts. fails_when=the download leaves its own mkdtemp folder or npm ci runs install scripts
test('the download unpacks from a private temp folder and npm ci runs no install scripts', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const download = src.slice(src.indexOf('async function download('), src.indexOf('async function main('));
  assert.doesNotMatch(download, /os\.tmpdir\(\)/, 'no fixed path in the shared temp folder');
  assert.match(download, /withTempFile\(/);
  assert.match(src, /'ci', '--omit=dev', '--ignore-scripts'/);
});
