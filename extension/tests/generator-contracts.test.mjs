// Contract tests: every generator must produce playbook-compliant HTML.
//
// If a generator stops emitting robots-meta, a favicon link, a topbar, or a
// footer, the deploy still succeeds (lint does not re-check generated files)
// but the rendered pages silently break. These tests guard against that.
//
// Ported from tests/test_generator_contracts.py when the generators moved
// from Python to Node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SCRIPTS_DIR,
  FIXTURES_DIR,
  initGitRepo,
  gitCommit,
  copyFixture,
} from './_helpers.mjs';

const changelog = await import(path.join(SCRIPTS_DIR, 'generate-changelog.mjs'));
const sitemap = await import(path.join(SCRIPTS_DIR, 'generate-sitemap.mjs'));
const references = await import(path.join(SCRIPTS_DIR, 'generate-references.mjs'));
const { extractSiteChrome } = await import(path.join(SCRIPTS_DIR, 'lib', 'chrome.mjs'));

// copyFixture('sample_site') returns { root, site, cleanup } where `site`
// is the sample_site copy. The tests expect a { root, cleanup } shape
// where `root` IS that copy; adapt once here.
function sampleSite() {
  const { site, cleanup } = copyFixture('sample_site');
  return { root: site, cleanup };
}

// ── Shared assertions ────────────────────────────────────────────────

function assertPlaybookCompliant(html, label) {
  // UTF-8 round-trip without a BOM.
  assert.ok(!html.startsWith('\uFEFF'), `${label}: output starts with BOM`);

  // Robots meta must include noindex.
  assert.ok(html.includes('name="robots"'), `${label}: missing robots meta`);
  const robotsTag = html.split('name="robots"', 2)[1].split('>', 1)[0];
  assert.ok(robotsTag.includes('noindex'), `${label}: robots meta missing noindex`);

  // Topbar + footer.
  assert.ok(html.includes('<header class="topbar">'), `${label}: missing topbar header`);
  assert.ok(html.includes('</header>'), `${label}: missing topbar closing tag`);
  assert.ok(html.includes('<footer>'), `${label}: missing footer`);
  assert.ok(html.includes('</footer>'), `${label}: missing footer closing tag`);

  // Styles + favicon: accept root-relative or root-absolute.
  assert.ok(
    html.includes('href="styles.css"') || html.includes('href="/styles.css"'),
    `${label}: styles.css not linked`,
  );
  assert.ok(html.includes('favicon'), `${label}: favicon link missing`);

  // Title present (normalize-title may overwrite later, but it must exist).
  assert.ok(html.includes('<title>') && html.includes('</title>'), `${label}: no <title> tag`);

  // Minimal doctype / html skeleton.
  assert.ok(html.trimStart().startsWith('<!DOCTYPE html>'), `${label}: missing doctype`);
}

// ── generate-changelog ───────────────────────────────────────────────

test('changelog output is playbook-compliant', () => {
  const { root, cleanup } = sampleSite();
  try {
    initGitRepo(root, 'git@github.com:Example/Sample.git');
    gitCommit(root, 'Initial import');

    const docs = path.join(root, 'docs');
    const { projectName, headHtml, topbar, footer } = extractSiteChrome(docs);
    let commits = changelog.getCommits(root);
    commits = changelog.filterCommits(commits);
    const html = changelog.buildHtml(commits, projectName, headHtml, topbar, footer);

    assertPlaybookCompliant(html, 'generate-changelog.mjs');
    assert.ok(html.includes('Sample Project'), 'title should reference project name');
    assert.ok(html.includes('Changelog'), 'should mention Changelog');
  } finally {
    cleanup();
  }
});

// ── generate-sitemap ─────────────────────────────────────────────────

test('sitemap output is playbook-compliant', () => {
  const { root, cleanup } = sampleSite();
  try {
    const docs = path.join(root, 'docs');
    const { projectName, headHtml, topbar, footer } = extractSiteChrome(docs);
    const html = sitemap.buildHtml(docs, projectName, headHtml, topbar, footer);

    assertPlaybookCompliant(html, 'generate-sitemap.mjs');
    assert.ok(html.includes('Sample Project'));
    assert.ok(html.includes('Sitemap'));
  } finally {
    cleanup();
  }
});

// ── generate-references ──────────────────────────────────────────────
// References is self-contained (hardcoded chrome); compliance is a weaker
// subset here because the page deliberately doesn't inherit the site
// topbar/sidebar. Match the coverage the Python contract test had.

test('references output is playbook-compliant', () => {
  const entries = [
    {
      file: 'sample.pdf',
      title: 'Sample Reference',
      description: 'A reference.',
      uploaded_at: '2026-04-16',
    },
  ];
  const html = references.buildHtml(entries);

  assertPlaybookCompliant(html, 'generate-references.mjs');
  assert.ok(html.includes('Sample Reference'));
  assert.ok(html.includes('References'));
});

// ── Guard: fixture still provides what the contract requires ────────

test('sample_site fixture provides the required chrome', () => {
  const html = readFileSync(
    path.join(FIXTURES_DIR, 'sample_site', 'docs', 'index.html'),
    'utf8',
  );
  assert.ok(html.includes('name="robots"'));
  assert.ok(html.includes('favicon'));
  assert.ok(html.includes('<header class="topbar">'));
  assert.ok(html.includes('<footer>'));
  assert.ok(html.includes('href="styles.css"'));
});
