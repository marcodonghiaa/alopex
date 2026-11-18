const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

// protects=following the documented test command never runs the real installer; fails_when=the
// doc says `node --test installer/`, which on Node 22 also runs installer/index.js (it downloads,
// installs and calls Supabase) (polish 5, item 1)
test('the installer test command runs only the test files', () => {
  const line = read('installer/README.md').split('\n').find((l) => l.startsWith('Tests:'));
  assert.ok(line, 'installer/README.md has a Tests: line');
  assert.doesNotMatch(line, /node --test installer\/`/);
  assert.match(line, /npm test|installer\/\*\.test\.js/);
});

// protects=the README describes post-sync in the order it runs; fails_when=it says Subscription /
// One-time is marked last while post-sync/index.ts runs it right after categories (polish 5, item 6)
test('the README lists the post-sync steps in the order they run', () => {
  const step = read('README.md').split('\n').find((l) => l.startsWith('2. `post-sync`'));
  const code = read('supabase/functions/post-sync/index.ts');
  const order = (text, marks) => marks.map((m) => text.indexOf(m));
  const ran = order(code, ['await categorize(', 'await classifyTypes(', 'await classifyFlows(', 'await markRefunds(']);
  assert.deepStrictEqual([...ran].sort((a, b) => a - b), ran, 'post-sync call order changed; update this test');
  const said = order(step, ['Gemini, for categories', '`Subscription` or `One-time`', 'marks `spend`', 'card refund']);
  assert.ok(said.every((i) => i >= 0), 'README step 2 names every post-sync step');
  assert.deepStrictEqual([...said].sort((a, b) => a - b), said);
});

// protects=self-hosters know everything a Gemini key sends; fails_when=the privacy notes leave out
// Splitwise expense descriptions, which post-sync also sends (categorizeSplitwise) (polish 5, item 7)
test('both Gemini privacy notes mention Splitwise', () => {
  const readmeRow = read('README.md').split('\n').find((l) => l.startsWith('| [Gemini API key]'));
  assert.match(readmeRow, /Splitwise/);
  const installer = read('installer/index.js');
  const note = installer.slice(installer.indexOf("console.log('Privacy:"), installer.indexOf('opts you out'));
  assert.match(note, /Splitwise/);
});

// protects=every installer release has upgrade notes for existing self-hosters; fails_when=the
// installer version is bumped (or not) without a matching "## v<version>" section in UPGRADING.md
test('UPGRADING.md has a section for the installer version', () => {
  const { version } = JSON.parse(read('installer/package.json'));
  assert.notStrictEqual(version, '0.1.0', 'this release bumps the installer past v0.1.0');
  assert.match(read('UPGRADING.md'), new RegExp(`^## v${version.replace(/\./g, '\\.')}\\b`, 'm'));
});

// protects=a plain `supabase functions deploy` gates every function as documented; fails_when=a new
// function dir has no verify_jwt entry in config.toml or no entry in supabase/functions/README.md
test('every Edge Function has a verify_jwt entry and a README entry', () => {
  const dirs = fs.readdirSync(path.join(__dirname, 'supabase/functions'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name);
  const config = read('supabase/config.toml');
  const readme = read('supabase/functions/README.md');
  assert.deepStrictEqual(dirs.filter((f) => !new RegExp(`\\[functions\\.${f}\\]\\nverify_jwt = (true|false)`).test(config)), []);
  assert.deepStrictEqual(dirs.filter((f) => !readme.includes(`- **${f}**`)), []);
});

// protects=the site says what the Splitwise integration does now; fails_when=a summary of it still
// says file-only (export / spreadsheet) while Alopex also syncs with a personal API key (polish-5 #12)
test('the site describes Splitwise as API sync plus the file import everywhere it sums it up', () => {
  const page = read('site/integrations/splitwise.html');
  const card = read('site/integrations.html').match(/href="\/integrations\/splitwise">[\s\S]*?<\/a>/)[0];
  const llms = read('site/llms.txt').split('\n').find((l) => l.includes('/integrations/splitwise'));
  const summaries = {
    title: page.match(/<title>(.*)<\/title>/)[1],
    meta: page.match(/<meta name="description" content="([^"]*)"/)[1],
    og: page.match(/<meta property="og:description" content="([^"]*)"/)[1],
    lede: page.match(/<p class="answer">(.*?)<\/p>/)[1],
    card,
    llms,
  };
  for (const [where, text] of Object.entries(summaries)) {
    assert.match(text, /\bsync|API/i, `${where} mentions the API sync: ${text}`);
  }
  for (const where of ['meta', 'lede', 'card', 'llms']) {
    assert.match(summaries[where], /export|file|CSV/i, `${where} still mentions the file import`);
  }
});

// protects=the site doesn't call the Splitwise key read-only: a Splitwise personal API key can
// write; only Alopex's use of it is read-only (README); fails_when=a sentence about Splitwise says
// "read-only key" / "read-only API key" (polish-5 re-audit P3-C)
test('the site never calls the Splitwise API key read-only', () => {
  const files = ['site/llms.txt', 'site/integrations.html', 'site/index.html',
    ...fs.readdirSync(path.join(__dirname, 'site/integrations')).map((f) => `site/integrations/${f}`)];
  const wrong = /Splitwise[^.<"\n]{0,60}read-only (personal )?(API )?keys?|read-only (personal )?(API )?keys? or from a Splitwise/gi;
  const found = files.flatMap((f) => (read(f).match(wrong) ?? []).map((m) => `${f}: ${m}`));
  assert.deepStrictEqual(found, []);
});
