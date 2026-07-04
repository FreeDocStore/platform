// Tests for the normalize-title CLI and its exported helpers.
// Covers the surface previously tested by tests/test_normalize_title.py.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'templates', 'search', 'scripts', 'normalize-title.mjs');
const SAMPLE_SITE = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample_site');

const lib = await import(SCRIPT);
const { getSiteTitle, setTitle, shouldProcess } = lib;

// ── fixture builders ─────────────────────────────────────────────────

function makeSite() {
  const root = mkdtempSync(path.join(tmpdir(), 'normalize-title-'));
  // Mirror the pytest `sample_site` fixture by copying the real fixture tree.
  cpSync(SAMPLE_SITE, root, { recursive: true });
  const docs = path.join(root, 'docs');
  return { root, docs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeEmpty() {
  const root = mkdtempSync(path.join(tmpdir(), 'normalize-title-empty-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runCli(args, repo) {
  return spawnSync('node', [SCRIPT, '--repo', repo, ...args], { encoding: 'utf8' });
}

// ── getSiteTitle ─────────────────────────────────────────────────────

test('getSiteTitle reads the badge', () => {
  const site = makeSite();
  try {
    assert.equal(getSiteTitle(site.docs), 'Sample Project');
  } finally {
    site.cleanup();
  }
});

test('getSiteTitle returns null when index is missing', () => {
  const site = makeEmpty();
  try {
    assert.equal(getSiteTitle(site.root), null);
  } finally {
    site.cleanup();
  }
});

test('getSiteTitle returns null when the badge is absent', () => {
  const site = makeEmpty();
  try {
    writeFileSync(path.join(site.root, 'index.html'), '<html><body><p>no badge here</p></body></html>');
    assert.equal(getSiteTitle(site.root), null);
  } finally {
    site.cleanup();
  }
});

test('getSiteTitle strips surrounding whitespace', () => {
  const site = makeEmpty();
  try {
    writeFileSync(
      path.join(site.root, 'index.html'),
      '<html><body><span class="badge">  Padded  </span></body></html>',
    );
    assert.equal(getSiteTitle(site.root), 'Padded');
  } finally {
    site.cleanup();
  }
});

// ── setTitle ─────────────────────────────────────────────────────────

test('setTitle replaces the existing title', () => {
  const html = '<html><head><title>Old - Sub</title></head><body></body></html>';
  const out = setTitle(html, 'New Title');
  assert.ok(out.includes('<title>New Title</title>'));
  assert.ok(!out.includes('Old - Sub'));
});

test('setTitle is a no-op when there is no <title> tag', () => {
  const html = '<html><body>no head</body></html>';
  assert.equal(setTitle(html, 'X'), html);
});

test('setTitle replaces only the first title occurrence', () => {
  const html = '<html><head><title>A</title></head><body><title>B</title></body></html>';
  const out = setTitle(html, 'X');
  assert.equal((out.match(/<title>X<\/title>/g) ?? []).length, 1);
  assert.ok(out.includes('<title>B</title>'));
});

test('setTitle escapes HTML special chars in the new title', () => {
  // Regression: a badge containing & or < used to land in the title raw,
  // producing invalid HTML and (worst case for </title>) breaking the
  // document structure. setTitle now HTML-escapes before injection.
  const html = '<html><head><title>Old</title></head></html>';
  const out = setTitle(html, 'Foo & </title> <bar>');
  assert.ok(out.includes('<title>Foo &amp; &lt;/title&gt; &lt;bar&gt;</title>'));
});

test('setTitle handles a title tag with attributes', () => {
  // Regression: the pattern was `<title>` (no attrs), so pages with
  // <title lang="en">...</title> were silently skipped.
  const html = '<html><head><title lang="en">Old</title></head></html>';
  const out = setTitle(html, 'New');
  assert.ok(out.includes('<title>New</title>'));
  assert.ok(!out.includes('Old'));
});

test('setTitle does not interpret $& / $1 in the title (replace special chars)', () => {
  // Regression: String.replace with a string template treats $& as
  // "the matched substring". A title containing $& was being expanded.
  const html = '<html><head><title>Old</title></head></html>';
  const out = setTitle(html, 'Price $5 & $& tag');
  assert.ok(out.includes('Price $5 &amp; $&amp; tag'));
});

// ── shouldProcess ────────────────────────────────────────────────────

test('shouldProcess skips *-pdf.html pages', () => {
  const html = '<html><body><header class="topbar"></header></body></html>';
  assert.equal(shouldProcess('guide-pdf.html', html), false);
});

test('shouldProcess skips pages using @page print CSS', () => {
  const html =
    '<html><head><style>@page { size: A4; }</style></head>' +
    '<body><header class="topbar"></header></body></html>';
  assert.equal(shouldProcess('printable.html', html), false);
});

test('shouldProcess skips pages without a topbar', () => {
  const html = '<html><body><main>hi</main></body></html>';
  assert.equal(shouldProcess('standalone.html', html), false);
});

test('shouldProcess accepts pages with a topbar', () => {
  const html = '<html><body><header class="topbar"><h1>x</h1></header></body></html>';
  assert.equal(shouldProcess('ok.html', html), true);
});

// ── CLI ──────────────────────────────────────────────────────────────

test('CLI sets the title on topbar pages and leaves others alone', () => {
  const site = makeSite();
  try {
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Sample Project/);

    for (const name of ['index.html', 'about.html']) {
      const html = readFileSync(path.join(site.docs, name), 'utf8');
      assert.ok(html.includes('<title>Sample Project</title>'), `${name} title not normalised`);
    }

    const guide = readFileSync(path.join(site.docs, 'guide.html'), 'utf8');
    assert.ok(guide.includes('<title>Guide - Sample Project</title>'));
    const orphan = readFileSync(path.join(site.docs, 'orphan.html'), 'utf8');
    assert.ok(orphan.includes('<title>Orphan Page - Sample Project</title>'));
  } finally {
    site.cleanup();
  }
});

test('CLI skips *-pdf.html even when it has a topbar', () => {
  const site = makeSite();
  try {
    const pdfPage = path.join(site.docs, 'guide-pdf.html');
    writeFileSync(
      pdfPage,
      '<!DOCTYPE html><html><head><title>Guide PDF</title></head>' +
        '<body><header class="topbar"></header></body></html>',
    );
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(pdfPage, 'utf8').includes('<title>Guide PDF</title>'));
  } finally {
    site.cleanup();
  }
});

test('CLI errors when the badge is missing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'normalize-title-nobadge-'));
  try {
    const docs = path.join(root, 'docs');
    mkdirSync(docs);
    writeFileSync(
      path.join(docs, 'index.html'),
      '<!DOCTYPE html><html><head><title>NoBadge</title></head><body></body></html>',
    );
    const r = runCli([], root);
    assert.notEqual(r.status, 0);
    const err = r.stderr.toLowerCase();
    assert.ok(err.includes('badge') || err.includes('title'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI errors when docs/ is missing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'normalize-title-nodocs-'));
  try {
    const r = runCli([], root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /docs\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI is idempotent', () => {
  const site = makeSite();
  try {
    runCli([], site.root);
    const first = readFileSync(path.join(site.docs, 'index.html'), 'utf8');
    runCli([], site.root);
    const second = readFileSync(path.join(site.docs, 'index.html'), 'utf8');
    assert.equal(first, second);
  } finally {
    site.cleanup();
  }
});
