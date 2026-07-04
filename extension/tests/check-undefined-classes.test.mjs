// Tests for check-undefined-classes.mjs.
// Covers the surface previously tested by tests/test_check_undefined_classes.py.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = path.join(
  REPO_ROOT, 'templates', 'search', 'scripts', 'check-undefined-classes.mjs',
);

const mod = await import(SCRIPT);
const { extractHtmlClasses, extractCssClasses, inlineStyles, SAFE } = mod;

// ── fixture builders ─────────────────────────────────────────────────

const STYLES_CSS = `/* Shared stylesheet for the undefined-classes fixture. */
.topbar { display: flex; }
.topbar-links { gap: 1rem; }
.badge { background: #eee; }
.card { padding: 1rem; }
.content { max-width: 60ch; }
.container { max-width: 80ch; }
.doc-title { font-size: 2rem; }
.grid-2 { display: grid; }
.nav-group { margin: 0; }
.nav-group-title { font-weight: 600; }
.sidebar { position: sticky; }
.topbar-logo { height: 24px; }
`;

const NAV_CSS = `.navbar-extra { color: blue; }
.verdict { padding: 4px; }
`;

const CLEAN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Clean Page</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header class="topbar">
  <nav class="topbar-links"><a href="other.html" class="active">Other</a></nav>
</header>
<main class="content">
  <div class="card highlight">
    <h1 class="doc-title">Hello</h1>
  </div>
</main>
</body>
</html>
`;

const INLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Inline Page</title>
<link rel="stylesheet" href="styles.css">
<style>
  .special { color: red; }
  /* .fake { color: blue; } */
</style>
</head>
<body>
<header class="topbar">
  <nav class="topbar-links"><a href="clean.html">Clean</a></nav>
</header>
<main class="content">
  <div class="special">Defined inline.</div>
</main>
</body>
</html>
`;

const MISSING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Missing Page</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header class="topbar">
  <nav class="topbar-links"><a href="clean.html">Clean</a></nav>
</header>
<main class="content">
  <div class="verdict high">Undefined: .verdict is not in styles.css nor inline.</div>
</main>
</body>
</html>
`;

function makeSite() {
  const root = mkdtempSync(path.join(tmpdir(), 'undefined-classes-'));
  const docs = path.join(root, 'docs');
  mkdirSync(docs);
  writeFileSync(path.join(docs, 'styles.css'), STYLES_CSS);
  writeFileSync(path.join(docs, 'clean.html'), CLEAN_HTML);
  writeFileSync(path.join(docs, 'inline.html'), INLINE_HTML);
  writeFileSync(path.join(docs, 'missing.html'), MISSING_HTML);
  writeFileSync(path.join(root, 'nav.css'), NAV_CSS);
  return { root, docs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runCli(args, repo) {
  return spawnSync('node', [SCRIPT, '--repo', repo, ...args], { encoding: 'utf8' });
}

// ── extractHtmlClasses ───────────────────────────────────────────────

test('extractHtmlClasses simple', () => {
  const out = extractHtmlClasses('<div class="a b c"></div>');
  assert.deepEqual([...out].sort(), ['a', 'b', 'c']);
});

test('extractHtmlClasses skips template-literal-only value', () => {
  const out = extractHtmlClasses('<div class="cell-${s}"></div>');
  assert.equal(out.size, 0);
});

test('extractHtmlClasses keeps static siblings of a template literal', () => {
  const out = extractHtmlClasses('<div class="tag ${dynamic}"></div>');
  assert.deepEqual([...out], ['tag']);
});

test('extractHtmlClasses walks multiple class attributes', () => {
  const out = extractHtmlClasses('<div class="foo"></div><span class="bar baz"></span>');
  assert.deepEqual([...out].sort(), ['bar', 'baz', 'foo']);
});

test('extractHtmlClasses drops {{handlebars}} tokens', () => {
  const out = extractHtmlClasses('<div class="tag {{name}}"></div>');
  assert.deepEqual([...out], ['tag']);
});

// ── extractCssClasses ────────────────────────────────────────────────

test('extractCssClasses basic', () => {
  const out = extractCssClasses('.foo { color: red; } .bar.baz { margin: 0; }');
  assert.deepEqual([...out].sort(), ['bar', 'baz', 'foo']);
});

test('extractCssClasses ignores single-line comments', () => {
  const out = extractCssClasses('/* .fake { color: red; } */ .real { color: blue; }');
  assert.ok(!out.has('fake'));
  assert.ok(out.has('real'));
});

test('extractCssClasses ignores multiline comments', () => {
  const css = '/*\n.fake-one { }\n.fake-two { }\n*/\n.keeper { }';
  const out = extractCssClasses(css);
  assert.deepEqual([...out], ['keeper']);
});

// ── inlineStyles ─────────────────────────────────────────────────────

test('inlineStyles single block', () => {
  const html = '<html><head><style>.x { color: red; }</style></head><body></body></html>';
  assert.ok(inlineStyles(html).includes('.x { color: red; }'));
});

test('inlineStyles multiple blocks', () => {
  const html = '<style>.a{}</style><p>hi</p><style>.b{}</style>';
  const out = inlineStyles(html);
  assert.ok(out.includes('.a{}'));
  assert.ok(out.includes('.b{}'));
});

test('inlineStyles with no style block returns empty string', () => {
  assert.equal(inlineStyles('<html><body>hi</body></html>'), '');
});

test('inlineStyles preserves newlines inside block', () => {
  const html = '<style>\n.multi {\n  color: red;\n}\n</style>';
  const out = inlineStyles(html);
  assert.ok(out.includes('.multi'));
  assert.ok(out.includes('color: red'));
});

// ── SAFE list ────────────────────────────────────────────────────────

test('SAFE contains known state modifiers', () => {
  for (const name of ['active', 'open', 'high', 'pagefind-ui']) {
    assert.ok(SAFE.has(name), `expected SAFE to contain ${name}`);
  }
});

// ── CLI: integration against a synthetic site ────────────────────────

test('CLI clean page reports nothing', () => {
  const site = makeSite();
  try {
    rmSync(path.join(site.docs, 'missing.html'));
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('undefined-classes'), r.stdout);
  } finally {
    site.cleanup();
  }
});

test('CLI reports missing class, skips SAFE modifier', () => {
  const site = makeSite();
  try {
    rmSync(path.join(site.docs, 'inline.html'));
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('undefined-classes: docs/missing.html'));
    assert.ok(r.stdout.includes('verdict'));
    // `high` is in SAFE so it must not appear on the missing.html line.
    const line = r.stdout.split('docs/missing.html:')[1].split('\n')[0];
    assert.ok(!line.includes('high'), `expected 'high' to be suppressed by SAFE, got: ${line}`);
  } finally {
    site.cleanup();
  }
});

test('CLI inline <style> suppresses report', () => {
  const site = makeSite();
  try {
    rmSync(path.join(site.docs, 'missing.html'));
    rmSync(path.join(site.docs, 'clean.html'));
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('special'), r.stdout);
  } finally {
    site.cleanup();
  }
});

test('CLI --extra-css suppresses otherwise-undefined class', () => {
  const site = makeSite();
  try {
    rmSync(path.join(site.docs, 'inline.html'));
    const extra = path.join(site.root, 'nav.css');
    const r = runCli(['--extra-css', extra], site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('undefined-classes'), r.stdout);
  } finally {
    site.cleanup();
  }
});

test('CLI with missing docs/ is quiet on stdout and exits 0', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'undefined-classes-empty-'));
  try {
    const r = runCli([], root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes('docs/'), r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI output exactly matches Python reference against full fixture', () => {
  // All three pages present; expect only the `verdict` class on missing.html.
  const site = makeSite();
  try {
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'undefined-classes: docs/missing.html: verdict\n');
  } finally {
    site.cleanup();
  }
});
