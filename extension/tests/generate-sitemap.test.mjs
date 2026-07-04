// Tests for generate-sitemap.mjs - mirrors the surface previously covered
// by tests/test_generate_sitemap.py.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = path.join(
  REPO_ROOT,
  'templates',
  'search',
  'scripts',
  'generate-sitemap.mjs',
);
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures');

const mod = await import(SCRIPT);
const { extractMeta, extractSectionsFromTopbar, buildHtml } = mod;

// ── fixture helpers ──────────────────────────────────────────────────

function copyFixture(name) {
  const root = mkdtempSync(path.join(tmpdir(), `sitemap-${name}-`));
  const dest = path.join(root, name);
  cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return {
    root,
    site: dest,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function sampleSite() {
  return copyFixture('sample_site');
}

function navdropSite() {
  return copyFixture('navdrop_site');
}

// A tiny ad-hoc site for tests that need to write their own HTML files.
function makeTmpDir() {
  const root = mkdtempSync(path.join(tmpdir(), 'sitemap-tmp-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// Inline clone of chrome.mjs's extractSiteChrome so tests can exercise
// buildHtml the way the Python tests did (they called extract_site_chrome
// on the docs dir). We re-import it rather than duplicate the logic.
const chrome = await import(
  path.join(REPO_ROOT, 'templates', 'search', 'scripts', 'lib', 'chrome.mjs')
);

function extractChrome(docsDir) {
  const { projectName, headHtml, topbar, footer } = chrome.extractSiteChrome(docsDir);
  return { projectName, headHtml, topbar, footer };
}

// ── site chrome ──────────────────────────────────────────────────────

test('extractSiteChrome returns project name, head, topbar', () => {
  const site = sampleSite();
  try {
    const { projectName, headHtml, topbar } = extractChrome(
      path.join(site.site, 'docs'),
    );
    assert.equal(projectName, 'Sample Project');
    assert.match(headHtml, /styles\.css/);
    assert.match(topbar, /<header class="topbar">/);
  } finally {
    site.cleanup();
  }
});

// ── section extraction ───────────────────────────────────────────────

test('standalone topbar links are extracted (sample_site)', () => {
  const site = sampleSite();
  try {
    const html = readFileSync(
      path.join(site.site, 'docs', 'index.html'),
      'utf8',
    );
    const topbar = html.match(/(<header class="topbar">[\s\S]*?<\/header>)/)[1];
    const sections = extractSectionsFromTopbar(topbar);
    const labels = new Set(sections.map(([l]) => l));
    assert.ok(labels.has('About'));
    assert.ok(labels.has('Guide'));
    assert.ok(!labels.has('Sitemap'));
    assert.ok(!labels.has('Changelog'));
  } finally {
    site.cleanup();
  }
});

test('navdrop standalone link is always picked up', () => {
  const site = navdropSite();
  try {
    const html = readFileSync(
      path.join(site.site, 'docs', 'index.html'),
      'utf8',
    );
    const topbar = html.match(/(<header class="topbar">[\s\S]*?<\/header>)/)[1];
    const sections = new Map(extractSectionsFromTopbar(topbar));
    assert.ok(sections.has('Dashboard'));
    assert.deepEqual(sections.get('Dashboard'), ['dashboard.html']);
  } finally {
    site.cleanup();
  }
});

test('navdrop groups include their menu links', () => {
  const site = navdropSite();
  try {
    const html = readFileSync(
      path.join(site.site, 'docs', 'index.html'),
      'utf8',
    );
    const topbar = html.match(/(<header class="topbar">[\s\S]*?<\/header>)/)[1];
    const sections = new Map(extractSectionsFromTopbar(topbar));
    assert.deepEqual(sections.get('Product'), ['concept.html', 'dimensions.html']);
    assert.deepEqual(sections.get('Build'), ['architecture.html', 'privacy.html']);
  } finally {
    site.cleanup();
  }
});

test('navdrop sections work with renderer markup (span/span)', () => {
  // Regression: lib/nav.mjs emits <span class="nav-drop"><span class="nav-drop-trigger">...
  // but the original regex only matched <div>/<a>. Every nav.json-driven
  // site lost grouped sections to the "Other" bucket. Test the actual
  // markup the renderer produces to keep the two in sync.
  const topbar = `
    <header class="topbar">
      <nav class="topbar-links">
        <span class="nav-drop">
          <span class="nav-drop-trigger">Product</span>
          <div class="nav-drop-menu">
            <a href="concept.html">Concept</a>
            <a href="dimensions.html">Dimensions</a>
          </div>
        </span>
        <a href="dashboard.html">Dashboard</a>
      </nav>
    </header>`;
  const sections = new Map(extractSectionsFromTopbar(topbar));
  assert.deepEqual(sections.get('Product'), ['concept.html', 'dimensions.html']);
  assert.deepEqual(sections.get('Dashboard'), ['dashboard.html']);
});

// ── page meta extraction ─────────────────────────────────────────────

test('extractMeta strips project suffix from title', () => {
  const site = sampleSite();
  try {
    const { title, summary } = extractMeta(
      path.join(site.site, 'docs', 'about.html'),
    );
    assert.equal(title, 'About');
    assert.match(summary, /About page summary/);
  } finally {
    site.cleanup();
  }
});

test('extractMeta truncates long summaries with ellipsis', () => {
  const t = makeTmpDir();
  try {
    const long = 'word '.repeat(100);
    const p = path.join(t.root, 'x.html');
    writeFileSync(
      p,
      `<html><head><title>Long</title></head><body><main><p>${long}</p></main></body></html>`,
    );
    const { title, summary } = extractMeta(p);
    assert.equal(title, 'Long');
    assert.ok(summary.endsWith('\u2026'));
    assert.ok(summary.length <= 180);
  } finally {
    t.cleanup();
  }
});

test('extractMeta falls back to file stem when <title> is missing', () => {
  const t = makeTmpDir();
  try {
    const p = path.join(t.root, 'pagename.html');
    writeFileSync(p, '<html><body><main><p>hello.</p></main></body></html>');
    const { title, summary } = extractMeta(p);
    assert.equal(title, 'pagename');
    assert.equal(summary, 'hello.');
  } finally {
    t.cleanup();
  }
});

// ── end-to-end HTML build ────────────────────────────────────────────

test('buildHtml produces expected sections and active link', () => {
  const site = sampleSite();
  try {
    const docs = path.join(site.site, 'docs');
    const { projectName, headHtml, topbar, footer } = extractChrome(docs);
    const html = buildHtml(docs, projectName, headHtml, topbar, footer);

    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.match(html, /<title>Sample Project - Sitemap<\/title>/);
    assert.match(html, /name="robots"/);
    assert.match(html, /href="sitemap\.html" class="active"/);
    // Overview always appears when index.html isn't otherwise bucketed.
    assert.match(html, /<h2>Overview<\/h2>/);
    // Topbar-derived sections.
    assert.match(html, /<h2>About<\/h2>/);
    assert.match(html, /<h2>Guide<\/h2>/);
    // Orphan page lands in "Other".
    assert.match(html, /<h2>Other<\/h2>/);
    assert.match(html, /class="card" href="orphan\.html"/);
    // 404 and the sitemap itself are never rendered as cards.
    assert.ok(!html.includes('class="card" href="404.html"'));
    assert.ok(!html.includes('class="card" href="sitemap.html"'));
  } finally {
    site.cleanup();
  }
});

test('buildHtml excludes sitemap.html and 404.html as cards', () => {
  const site = sampleSite();
  try {
    const docs = path.join(site.site, 'docs');
    // Pre-existing sitemap.html must not include itself.
    writeFileSync(
      path.join(docs, 'sitemap.html'),
      '<html><head><title>Sitemap</title></head><body><main><p>x</p></main></body></html>',
    );
    const { projectName, headHtml, topbar, footer } = extractChrome(docs);
    const html = buildHtml(docs, projectName, headHtml, topbar, footer);
    assert.ok(!html.includes('class="card" href="sitemap.html"'));
    assert.ok(!html.includes('class="card" href="404.html"'));
  } finally {
    site.cleanup();
  }
});

test('CLI writes docs/sitemap.html', () => {
  const site = sampleSite();
  try {
    const r = spawnSync('node', [SCRIPT, '--repo', site.site], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = readFileSync(
      path.join(site.site, 'docs', 'sitemap.html'),
      'utf8',
    );
    assert.match(out, /Sitemap/);
    assert.match(out, /<h2>About<\/h2>/);
  } finally {
    site.cleanup();
  }
});
