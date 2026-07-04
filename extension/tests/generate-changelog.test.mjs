// Tests for the generate-changelog CLI and its exported helpers.
// Covers the surface previously tested by tests/test_generate_changelog.py.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SCRIPTS_DIR,
  initGitRepo,
  gitCommit,
  makeSampleSite,
  mkdtempBare,
} from './_helpers.mjs';

const SCRIPT = path.join(SCRIPTS_DIR, 'generate-changelog.mjs');

const lib = await import(SCRIPT);
const {
  filterCommits,
  isSkipCi,
  categoriseFiles,
  formatDate,
  buildHtml,
  getCommits,
  escapeHtml,
} = lib;

function makeEmpty() {
  return mkdtempBare('gen-changelog-empty-');
}

function runCli(args, repo) {
  return spawnSync('node', [SCRIPT, '--repo', repo, ...args], {
    encoding: 'utf8',
  });
}

// ── File categorisation ──────────────────────────────────────────────

const CATEGORY_CASES = [
  ['docs/index.html', 'Pages'],
  ['docs/about.html', 'Pages'],
  ['templates/search/scripts/generate-changelog.py', 'Scripts'],
  ['scripts/thing.mjs', 'Scripts'],
  ['scripts/run.sh', 'Scripts'],
  ['docs/styles.css', 'Styles'],
  ['sources/report.pdf', 'Documents'],
  ['docs/proposal.DOCX', 'Documents'],
  ['sources/notes.md', 'Sources'],
  ['.github/workflows/deploy.yml', 'Workflows'],
  ['README.md', 'Other'],
];

for (const [filename, bucket] of CATEGORY_CASES) {
  test(`categoriseFiles: ${filename} -> ${bucket}`, () => {
    const cats = categoriseFiles([filename]);
    assert.ok(bucket in cats, `${filename} bucketed into ${Object.keys(cats)}`);
    assert.ok(cats[bucket].includes(filename));
  });
}

test('categoriseFiles prunes empty buckets', () => {
  const cats = categoriseFiles(['docs/a.html']);
  assert.deepEqual(Object.keys(cats), ['Pages']);
});

test('categoriseFiles: pdf beats docs/ page rule', () => {
  const cats = categoriseFiles(['docs/report.pdf']);
  assert.ok('Documents' in cats);
  assert.ok(!('Pages' in cats));
});

// ── Commit filtering ─────────────────────────────────────────────────

test('filterCommits skips [skip ci]', () => {
  const commits = [
    { sha: 'a', subject: 'Normal change', body: '', date: '', files: ['a.txt'] },
    { sha: 'b', subject: 'noise [skip ci]', body: '', date: '', files: ['a.txt'] },
  ];
  const out = filterCommits(commits);
  assert.deepEqual(out.map((c) => c.sha), ['a']);
});

test('isSkipCi: recognises every directive GitHub Actions accepts', () => {
  // Regression: only `[skip ci]` was matched. The five other forms below
  // ALL skip the GitHub Actions workflow run, so a commit with any of
  // them never has its changelog updated by CI - but the next non-skip
  // commit would replay them all into the regenerated changelog.
  // Documented at github.com/.../skipping-workflow-runs.
  for (const tag of [
    '[skip ci]',
    '[ci skip]',
    '[no ci]',
    '[skip actions]',
    '[actions skip]',
    '***NO_CI***',
  ]) {
    assert.equal(
      isSkipCi({ subject: `Some change ${tag}`, body: '' }),
      true,
      `expected '${tag}' to be detected as a skip-CI directive`,
    );
  }
});

test('isSkipCi: directive in the body (not just subject) still skips', () => {
  // GitHub treats the whole commit message - subject + body - so a
  // directive in the body suppresses the workflow run. Our filter used
  // to only check the subject, so body-skip commits would slip into
  // the regenerated changelog.
  assert.equal(
    isSkipCi({ subject: 'Refactor', body: 'Big rename.\n\n[skip ci]\n' }),
    true,
  );
  assert.equal(
    isSkipCi({ subject: 'Refactor', body: 'No directive in here.' }),
    false,
  );
});

test('isSkipCi: case-sensitive (matches GitHub behaviour)', () => {
  // GitHub matches the directives case-sensitively; `[Skip CI]` does NOT
  // skip the workflow. Stay consistent.
  assert.equal(isSkipCi({ subject: 'Change [Skip CI]', body: '' }), false);
  assert.equal(isSkipCi({ subject: 'Change [SKIP CI]', body: '' }), false);
  // The exact lowercase form does match.
  assert.equal(isSkipCi({ subject: 'Change [skip ci]', body: '' }), true);
});

test('filterCommits drops changelog-only commits', () => {
  const commits = [
    { sha: 'a', subject: 'Chore', body: '', date: '', files: ['docs/changelog.html'] },
    {
      sha: 'b',
      subject: 'Real change',
      body: '',
      date: '',
      files: ['docs/changelog.html', 'docs/index.html'],
    },
  ];
  const out = filterCommits(commits);
  assert.deepEqual(out.map((c) => c.sha), ['b']);
  // changelog path stripped from the remaining commit's file list
  assert.deepEqual(out[0].files, ['docs/index.html']);
});

// ── Date formatting ──────────────────────────────────────────────────

test('formatDate converts UTC to AEST', () => {
  // 2024-01-01T00:00:00+00:00 should be 11:00 AEST (UTC+11) on 01 Jan.
  assert.equal(formatDate('2024-01-01T00:00:00+00:00'), '01 Jan 2024, 11:00');
});

test('formatDate accepts Z-suffix timestamps (documented past bug)', () => {
  // Pre-3.11 Python's datetime.fromisoformat choked on Z; the Node port
  // must accept both Z and +HH:MM. The output must match the +00:00 form.
  assert.equal(formatDate('2024-01-01T00:00:00Z'), '01 Jan 2024, 11:00');
});

test('formatDate handles non-UTC offsets', () => {
  // 2024-06-15T09:00:00+10:00 == 2024-06-14T23:00:00Z == 2024-06-15T10:00 AEST.
  assert.equal(formatDate('2024-06-15T09:00:00+10:00'), '15 Jun 2024, 10:00');
});

test('formatDate falls back on garbled input (first 10 chars)', () => {
  assert.equal(formatDate('garbled-input-value'), 'garbled-in');
});

// ── escapeHtml ───────────────────────────────────────────────────────

test('escapeHtml escapes the standard set', () => {
  const out = escapeHtml(`<a href="x">Tips & 'tricks'</a>`);
  assert.equal(
    out,
    '&lt;a href=&quot;x&quot;&gt;Tips &amp; &#x27;tricks&#x27;&lt;/a&gt;',
  );
});

// ── buildHtml ────────────────────────────────────────────────────────

test('buildHtml contains expected structural bits', () => {
  const commits = [
    {
      sha: 'abcdef1234567890',
      subject: 'My subject',
      body: 'a body\nCo-Authored-By: x <y@z>',
      date: '2024-01-01T00:00:00Z',
      files: ['docs/index.html'],
    },
  ];
  const html = buildHtml(commits, 'Demo', '', '<header class="topbar"><a href="changelog.html">Changelog</a></header>', '<footer></footer>');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<title>Demo - Changelog</title>'));
  assert.ok(html.includes('name="robots"'));
  assert.ok(html.includes('href="changelog.html" class="active"'));
  assert.ok(html.includes('1 commits'));
  assert.ok(html.includes('My subject'));
  // Co-Authored-By trailer is filtered out of the body block.
  assert.ok(!html.includes('Co-Authored-By'));
  // Short sha is 7 chars.
  assert.ok(html.includes('abcdef1'));
});

// ── End-to-end: real git repo ────────────────────────────────────────

test('getCommits includes the root commit (--root flag is load-bearing)', () => {
  const site = makeSampleSite();
  try {
    initGitRepo(site.root, 'git@github.com:Example/Sample.git');
    gitCommit(site.root, 'Initial import');
    const commits = filterCommits(getCommits(site.root));
    assert.ok(
      commits.some((c) => c.subject === 'Initial import'),
      `root commit missing: ${JSON.stringify(commits.map((c) => c.subject))}`,
    );
    // Files from the initial commit must be captured (this is what --root fixes).
    const initial = commits.find((c) => c.subject === 'Initial import');
    assert.ok(initial.files.length > 0, 'initial commit should list its files');
    assert.ok(initial.files.some((f) => f.startsWith('docs/')));
  } finally {
    site.cleanup();
  }
});

test('getCommits + filterCommits skips [skip ci] and changelog-only commits', () => {
  const site = makeSampleSite();
  try {
    initGitRepo(site.root, 'git@github.com:Example/Sample.git');
    gitCommit(site.root, 'Initial import');

    // changelog-only commit (should be filtered)
    writeFileSync(path.join(site.docs, 'changelog.html'), '<!-- placeholder -->');
    gitCommit(site.root, 'chore: write placeholder changelog');

    // [skip ci] commit (should be filtered)
    const guidePath = path.join(site.docs, 'guide.html');
    writeFileSync(guidePath, readFileSync(guidePath, 'utf8') + '\n<!-- tweak -->');
    gitCommit(site.root, 'Update guide [skip ci]');

    // Real commit (should show up)
    const aboutPath = path.join(site.docs, 'about.html');
    writeFileSync(aboutPath, readFileSync(aboutPath, 'utf8') + '\n<!-- tweak -->');
    gitCommit(site.root, 'Update about page');

    const commits = filterCommits(getCommits(site.root));
    const subjects = commits.map((c) => c.subject);
    assert.ok(subjects.includes('Update about page'));
    assert.ok(!subjects.includes('Update guide [skip ci]'));
    assert.ok(!subjects.includes('chore: write placeholder changelog'));
  } finally {
    site.cleanup();
  }
});

test('End-to-end: CLI writes a valid changelog.html', () => {
  const site = makeSampleSite();
  try {
    initGitRepo(site.root, 'https://github.com/Example/Sample.git');
    gitCommit(site.root, 'first');
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    const out = readFileSync(path.join(site.docs, 'changelog.html'), 'utf8');
    assert.ok(out.includes('<!DOCTYPE html>'));
    assert.ok(out.includes('Changelog'));
    assert.ok(out.includes('<title>Sample Project - Changelog</title>'));
    assert.ok(out.includes('href="changelog.html" class="active"'));
  } finally {
    site.cleanup();
  }
});

test('CLI errors when docs/ is missing', () => {
  const site = makeEmpty();
  try {
    const r = runCli([], site.root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /docs\//);
  } finally {
    site.cleanup();
  }
});

const chromeLib = await import(path.join(SCRIPTS_DIR, 'lib', 'chrome.mjs'));

test('End-to-end: full build_html against real repo contains subjects', () => {
  const site = makeSampleSite();
  try {
    initGitRepo(site.root, 'git@github.com:Example/Sample.git');
    gitCommit(site.root, 'Initial import');

    const aboutPath = path.join(site.docs, 'about.html');
    writeFileSync(aboutPath, readFileSync(aboutPath, 'utf8') + '\n<!-- tweak -->');
    gitCommit(site.root, 'Update about page');

    const commits = filterCommits(getCommits(site.root));
    const { projectName, headHtml, topbar, footer } = chromeLib.extractSiteChrome(site.docs);
    const html = buildHtml(commits, projectName, headHtml, topbar, footer);
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<title>Sample Project - Changelog</title>'));
    assert.ok(html.includes(`${commits.length} commits`));
    for (const c of commits) {
      assert.ok(html.includes(c.subject), `subject missing: ${c.subject}`);
    }
  } finally {
    site.cleanup();
  }
});
