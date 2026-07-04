// Tests for the shared nav library and the inject-nav CLI script.
// Covers the surface previously tested by tests/test_inject_nav.py.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SHARED_LIB = path.join(REPO_ROOT, 'templates', 'search', 'scripts', 'lib', 'nav.mjs');
const SCRIPT = path.join(REPO_ROOT, 'templates', 'search', 'scripts', 'inject-nav.mjs');

const lib = await import(SHARED_LIB);
const { parseNavConfig, renderNav, injectNav, lintNav, collectHrefs } = lib;

// ── fixture builders ─────────────────────────────────────────────────

const PAGE_WITH_TOPBAR = `<!DOCTYPE html>
<html><head></head><body>
<header class="topbar">
  <nav class="topbar-links">
    <a href="about.html">About</a>
    <a href="guide.html">Guide</a>
  </nav>
</header>
</body></html>`;

const PAGE_WITHOUT_TOPBAR = `<!DOCTYPE html>
<html><head></head><body><p>no topbar</p></body></html>`;

function makeSite() {
  const root = mkdtempSync(path.join(tmpdir(), 'inject-nav-'));
  const docs = path.join(root, 'docs');
  mkdirSync(docs);
  writeFileSync(path.join(docs, 'index.html'), PAGE_WITH_TOPBAR);
  writeFileSync(path.join(docs, 'about.html'), PAGE_WITH_TOPBAR);
  writeFileSync(path.join(docs, 'guide.html'), PAGE_WITHOUT_TOPBAR);
  writeFileSync(path.join(docs, '404.html'), PAGE_WITHOUT_TOPBAR);
  writeFileSync(path.join(docs, 'orphan.html'), PAGE_WITHOUT_TOPBAR);
  return { root, docs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeNav(docs, config) {
  writeFileSync(path.join(docs, 'nav.json'), JSON.stringify(config));
}

function runCli(args, repo) {
  return spawnSync('node', [SCRIPT, '--repo', repo, ...args], { encoding: 'utf8' });
}

// ── renderNav ────────────────────────────────────────────────────────

test('renderNav flat list', () => {
  const items = [
    { href: 'about.html', label: 'About' },
    { href: 'guide.html', label: 'Guide' },
  ];
  const out = renderNav(items, 'about.html');
  assert.ok(out.startsWith('<nav class="topbar-links">'));
  assert.ok(out.endsWith('</nav>'));
  assert.match(out, /<a href="about\.html" class="active">About<\/a>/);
  assert.match(out, /<a href="guide\.html">Guide<\/a>/);
});

test('renderNav marks exactly one active link per page', () => {
  const items = [
    { href: 'about.html', label: 'About' },
    { href: 'guide.html', label: 'Guide' },
  ];
  const a = renderNav(items, 'about.html');
  const g = renderNav(items, 'guide.html');
  assert.match(a, /href="about\.html" class="active"/);
  assert.doesNotMatch(a, /href="guide\.html" class="active"/);
  assert.match(g, /href="guide\.html" class="active"/);
  assert.doesNotMatch(g, /href="about\.html" class="active"/);
});

test('renderNav dropdown with children', () => {
  const items = [
    { href: 'about.html', label: 'About' },
    {
      label: 'Reference',
      children: [
        { href: 'issues.html', label: 'Issues' },
        { href: 'dashboard.html', label: 'Dashboard' },
      ],
    },
  ];
  const out = renderNav(items, 'issues.html');
  assert.match(out, /<span class="nav-drop">/);
  assert.match(out, /<span class="nav-drop-trigger">Reference<\/span>/);
  assert.match(out, /<div class="nav-drop-menu">/);
  assert.match(out, /<a href="issues\.html" class="active">Issues<\/a>/);
  assert.match(out, /<a href="dashboard\.html">Dashboard<\/a>/);
});

test('renderNav escapes label special chars', () => {
  const out = renderNav([{ href: 'a.html', label: 'Tips & Tricks' }], 'a.html');
  assert.match(out, /Tips &amp; Tricks/);
  assert.doesNotMatch(out, /Tips & Tricks/);

  const hostile = renderNav(
    [{ href: 'a.html', label: '<script>x</script>' }],
    'a.html',
  );
  assert.match(hostile, /&lt;script&gt;/);
  assert.doesNotMatch(hostile, /<script>/);
});

test('renderNav escapes href quotes and special chars', () => {
  const out = renderNav([{ href: 'a.html?x="y"', label: 'A' }], 'a.html');
  assert.match(out, /&quot;/);
  // The raw unescaped href must never appear between the wrapping quotes.
  assert.doesNotMatch(out, /href="a\.html\?x="y""/);
});

// ── injectNav ────────────────────────────────────────────────────────

test('injectNav replaces the topbar-links block', () => {
  const html = '<header class="topbar"><nav class="topbar-links"><a href="old.html">Old</a></nav></header>';
  const navHtml = renderNav([{ href: 'new.html', label: 'New' }], 'new.html');
  const out = injectNav(html, navHtml);
  assert.doesNotMatch(out, /href="old\.html"/);
  assert.match(out, /<a href="new\.html" class="active">New<\/a>/);
});

test('injectNav is idempotent', () => {
  const html = '<header class="topbar"><nav class="topbar-links"><a href="a.html">A</a></nav></header>';
  const navHtml = renderNav([{ href: 'a.html', label: 'A' }], 'a.html');
  const once = injectNav(html, navHtml);
  const twice = injectNav(once, navHtml);
  assert.equal(once, twice);
  assert.equal((once.match(/<nav class="topbar-links">/g) ?? []).length, 1);
});

test('injectNav is a no-op when there is no topbar-links block', () => {
  const html = '<html><body><p>nothing here</p></body></html>';
  const navHtml = renderNav([{ href: 'a.html', label: 'A' }], 'a.html');
  assert.equal(injectNav(html, navHtml), html);
});

// ── lintNav ──────────────────────────────────────────────────────────

test('lintNav passes when every page is in items or navSkip', () => {
  const config = {
    items: [{ href: 'about.html', label: 'About' }, { href: 'guide.html', label: 'Guide' }],
    navSkip: ['index.html', '404.html', 'orphan.html'],
  };
  const pages = ['index.html', 'about.html', 'guide.html', '404.html', 'orphan.html'];
  assert.deepEqual(lintNav(pages, config), []);
});

test('lintNav reports orphan pages', () => {
  const config = {
    items: [{ href: 'about.html', label: 'About' }],
    navSkip: ['index.html', '404.html', 'orphan.html'],
  };
  const pages = ['index.html', 'about.html', 'guide.html', '404.html', 'orphan.html'];
  const errors = lintNav(pages, config);
  assert.ok(errors.length, 'expected orphan error');
  assert.ok(errors.some((e) => e.includes('guide.html')));
});

test('lintNav reports broken hrefs', () => {
  const config = {
    items: [
      { href: 'about.html', label: 'About' },
      { href: 'does-not-exist.html', label: 'Ghost' },
    ],
    navSkip: ['index.html', '404.html', 'orphan.html', 'guide.html'],
  };
  const pages = ['index.html', 'about.html', 'guide.html', '404.html', 'orphan.html'];
  const errors = lintNav(pages, config);
  assert.ok(errors.length);
  assert.ok(errors.some((e) => e.includes('does-not-exist.html')));
});

// ── collectHrefs ─────────────────────────────────────────────────────

test('collectHrefs walks dropdown children', () => {
  const items = [
    { href: 'a.html', label: 'A' },
    { label: 'Group', children: [{ href: 'b.html', label: 'B' }, { href: 'c.html', label: 'C' }] },
  ];
  assert.deepEqual(collectHrefs(items), ['a.html', 'b.html', 'c.html']);
});

test('lintNav implicit-skips 404.html (universal convention, not in nav.json)', () => {
  // Regression: previously a deploy would fail if a repo had docs/404.html
  // but forgot to add it to navSkip. Five consecutive playbook deploys
  // failed for exactly this reason. 404 pages are a Cloudflare Pages
  // convention served on any URL miss - never a topbar entry.
  const config = { items: [{ href: 'a.html', label: 'A' }], navSkip: [] };
  const errors = lintNav(['a.html', '404.html'], config);
  assert.deepEqual(errors, []);
});

test('lintNav implicit-skips sitemap.html (auto-generated, footer link)', () => {
  // generate-sitemap.mjs produces docs/sitemap.html. It belongs in the
  // footer/standalone link, not the topbar.
  const config = { items: [{ href: 'a.html', label: 'A' }], navSkip: [] };
  const errors = lintNav(['a.html', 'sitemap.html'], config);
  assert.deepEqual(errors, []);
});

test('lintNav still flags genuinely-orphan pages (regression guard)', () => {
  // Hardening must not turn into "skip every missing entry". Any page
  // that's NOT in the implicit list AND NOT in items/navSkip still
  // surfaces as an orphan - that's the whole point of the lint.
  const config = { items: [{ href: 'a.html', label: 'A' }], navSkip: [] };
  const errors = lintNav(['a.html', 'b.html'], config);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /b\.html/);
});

test('IMPLICIT_NAV_SKIP exports the universal skip set', () => {
  assert.ok(lib.IMPLICIT_NAV_SKIP instanceof Set);
  assert.ok(lib.IMPLICIT_NAV_SKIP.has('404.html'));
  assert.ok(lib.IMPLICIT_NAV_SKIP.has('sitemap.html'));
  assert.ok(lib.IMPLICIT_NAV_SKIP.has('changelog.html'));
});

test('lintNav passes when generated changelog.html is missing from nav.json', () => {
  // Regression: changelog.html is generated at deploy time. If a user
  // enables the changelog add-on but forgets to add it to nav.json (or
  // navSkip), the lint used to fail. IMPLICIT_NAV_SKIP now covers it.
  const errors = lib.lintNav(['index.html', 'changelog.html'], { items: [{ label: 'Home', href: 'index.html' }] });
  assert.deepEqual(errors, []);
});

test('parseNavConfig rejects grandchildren (renderer is single-level)', () => {
  // Regression: isNavItem used to validate children recursively, so a
  // schema with grandchildren passed validation but the renderer dropped
  // them silently and rendered href="undefined" for the parent links.
  // Now we reject the schema up front with a clear "null result".
  const raw = JSON.stringify({
    items: [
      {
        label: 'Parent',
        children: [
          {
            label: 'Subgroup',
            children: [{ href: 'leaf.html', label: 'Leaf' }],
          },
        ],
      },
    ],
  });
  assert.equal(parseNavConfig(raw), null);
});

test('parseNavConfig rejects a child that lacks href', () => {
  // Children must be leaves with both label + href. A label-only child
  // has nowhere to link, so reject rather than render <a href="undefined">.
  const raw = JSON.stringify({
    items: [
      {
        label: 'Parent',
        children: [{ label: 'No-href child' }],
      },
    ],
  });
  assert.equal(parseNavConfig(raw), null);
});

// ── CLI ──────────────────────────────────────────────────────────────

test('CLI updates pages with topbar when nav.json is valid', () => {
  const site = makeSite();
  try {
    writeNav(site.docs, {
      items: [{ href: 'about.html', label: 'About' }, { href: 'guide.html', label: 'Guide' }],
      navSkip: ['index.html', 'orphan.html', '404.html'],
    });
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    const index = readFileSync(path.join(site.docs, 'index.html'), 'utf8');
    assert.match(index, /<a href="about\.html">About<\/a>/);
    assert.match(index, /<a href="guide\.html">Guide<\/a>/);
  } finally {
    site.cleanup();
  }
});

test('CLI without nav.json is a no-op with exit 0', () => {
  const site = makeSite();
  try {
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /skipping/);
  } finally {
    site.cleanup();
  }
});

test('CLI --check fails on orphan and does not mutate', () => {
  const site = makeSite();
  try {
    writeNav(site.docs, {
      items: [{ href: 'about.html', label: 'About' }],
      navSkip: ['index.html', 'orphan.html', '404.html'],
    });
    const before = readFileSync(path.join(site.docs, 'index.html'), 'utf8');
    const r = runCli(['--check'], site.root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /guide\.html/);
    const after = readFileSync(path.join(site.docs, 'index.html'), 'utf8');
    assert.equal(after, before);
  } finally {
    site.cleanup();
  }
});

test('CLI --check passes and does not mutate when lint is clean', () => {
  const site = makeSite();
  try {
    writeNav(site.docs, {
      items: [{ href: 'about.html', label: 'About' }, { href: 'guide.html', label: 'Guide' }],
      navSkip: ['index.html', 'orphan.html', '404.html'],
    });
    const before = readFileSync(path.join(site.docs, 'index.html'), 'utf8');
    const r = runCli(['--check'], site.root);
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(path.join(site.docs, 'index.html'), 'utf8');
    assert.equal(after, before);
  } finally {
    site.cleanup();
  }
});

test('CLI rejects malformed nav.json', () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.docs, 'nav.json'), '{ not json');
    const r = runCli([], site.root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not a valid NavConfig/);
  } finally {
    site.cleanup();
  }
});

test('CLI is idempotent', () => {
  const site = makeSite();
  try {
    writeNav(site.docs, {
      items: [{ href: 'about.html', label: 'About' }, { href: 'guide.html', label: 'Guide' }],
      navSkip: ['index.html', 'orphan.html', '404.html'],
    });
    runCli([], site.root);
    const first = readFileSync(path.join(site.docs, 'index.html'), 'utf8');
    runCli([], site.root);
    const second = readFileSync(path.join(site.docs, 'index.html'), 'utf8');
    assert.equal(first, second);
  } finally {
    site.cleanup();
  }
});

test('CLI skips pages without a topbar header', () => {
  const site = makeSite();
  try {
    writeNav(site.docs, {
      items: [{ href: 'about.html', label: 'About' }, { href: 'guide.html', label: 'Guide' }],
      navSkip: ['index.html', 'orphan.html', '404.html'],
    });
    const guideBefore = readFileSync(path.join(site.docs, 'guide.html'), 'utf8');
    const orphanBefore = readFileSync(path.join(site.docs, 'orphan.html'), 'utf8');
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path.join(site.docs, 'guide.html'), 'utf8'), guideBefore);
    assert.equal(readFileSync(path.join(site.docs, 'orphan.html'), 'utf8'), orphanBefore);
  } finally {
    site.cleanup();
  }
});
