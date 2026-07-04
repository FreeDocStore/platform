// Tests for the generate-references CLI and its exported helpers.
// Ports the surface previously covered by tests/test_generate_references.py.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
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
  'generate-references.mjs',
);

const mod = await import(SCRIPT);
const { validate, renderRows, buildHtml, escapeHtml, quote } = mod;

// ── fixture builders ─────────────────────────────────────────────────

function makeSite() {
  const root = mkdtempSync(path.join(tmpdir(), 'gen-refs-'));
  const refs = path.join(root, 'docs', 'references');
  mkdirSync(refs, { recursive: true });
  return {
    root,
    refs,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runCli(repo) {
  return spawnSync('node', [SCRIPT, '--repo', repo], { encoding: 'utf8' });
}

function writeManifest(refs, obj) {
  writeFileSync(path.join(refs, 'manifest.json'), JSON.stringify(obj));
}

// ── helpers ──────────────────────────────────────────────────────────

test('escapeHtml escapes the same chars as Python html.escape', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
  );
  assert.equal(escapeHtml("a & b"), 'a &amp; b');
  assert.equal(escapeHtml("it's"), 'it&#x27;s');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('quote matches urllib.parse.quote defaults for simple filenames', () => {
  assert.equal(quote('brief.docx'), 'brief.docx');
  assert.equal(quote('a.pdf'), 'a.pdf');
  assert.equal(quote('foo-bar_baz.1.2.pdf'), 'foo-bar_baz.1.2.pdf');
});

test('quote preserves "/" (urllib safe="/" default)', () => {
  assert.equal(quote('sub/dir/file.pdf'), 'sub/dir/file.pdf');
});

test('quote percent-encodes spaces and sub-delims the same as urllib', () => {
  assert.equal(quote('a file.pdf'), 'a%20file.pdf');
  assert.equal(quote("o'neil.pdf"), 'o%27neil.pdf');
  assert.equal(quote('x(y).pdf'), 'x%28y%29.pdf');
  assert.equal(quote('wow!.pdf'), 'wow%21.pdf');
  assert.equal(quote('star*.pdf'), 'star%2A.pdf');
});

// ── validate ─────────────────────────────────────────────────────────

test('validate: clean manifest yields no errors', () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'brief.docx'), 'x');
    const errs = validate(
      [{ file: 'brief.docx', title: 'Brief' }],
      site.refs,
    );
    assert.deepEqual(errs, []);
  } finally {
    site.cleanup();
  }
});

test('validate: reports entry missing file', () => {
  const site = makeSite();
  try {
    const errs = validate(
      [{ file: 'ghost.pdf', title: 'Ghost' }],
      site.refs,
    );
    assert.ok(errs.some((e) => e.includes('missing file: ghost.pdf')));
  } finally {
    site.cleanup();
  }
});

test('validate: reports orphan files on disk', () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'orphan.pdf'), 'x');
    const errs = validate([], site.refs);
    assert.ok(errs.some((e) => e.includes('not listed in manifest.json: orphan.pdf')));
  } finally {
    site.cleanup();
  }
});

test('validate: reports entry missing title', () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'brief.docx'), 'x');
    const errs = validate([{ file: 'brief.docx' }], site.refs);
    assert.ok(errs.some((e) => e.includes("is missing 'title'")));
  } finally {
    site.cleanup();
  }
});

test("validate: ignores META_FILES (manifest.schema.json, index.html)", () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'manifest.schema.json'), '{}');
    writeFileSync(path.join(site.refs, 'index.html'), '<html></html>');
    const errs = validate([], site.refs);
    assert.deepEqual(errs, []);
  } finally {
    site.cleanup();
  }
});

test("validate: entry without 'file' field", () => {
  const site = makeSite();
  try {
    const errs = validate([{ title: 'No file' }], site.refs);
    assert.ok(errs.some((e) => e.includes("entry missing 'file' field")));
  } finally {
    site.cleanup();
  }
});

// ── renderRows / buildHtml ───────────────────────────────────────────

test('renderRows sorts by uploaded_at descending', () => {
  const out = renderRows([
    { file: 'a.pdf', title: 'Older', uploaded_at: '2026-01-01' },
    { file: 'b.pdf', title: 'Newer', uploaded_at: '2026-04-01' },
  ]);
  assert.ok(out.indexOf('Newer') < out.indexOf('Older'));
});

test('renderRows renders tags inline', () => {
  const out = renderRows([
    { file: 'a.pdf', title: 'T', tags: ['alpha', 'beta'] },
  ]);
  assert.match(out, /<span class="tag">alpha<\/span>/);
  assert.match(out, /<span class="tag">beta<\/span>/);
});

test('renderRows escapes user-supplied fields', () => {
  const out = renderRows([
    {
      file: 'brief.docx',
      title: '<script>x</script>',
      description: 'a & b',
      tags: ['<b>'],
    },
  ]);
  assert.doesNotMatch(out, /<script>x<\/script>/);
  assert.match(out, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(out, /a &amp; b/);
  assert.match(out, /&lt;b&gt;/);
});

test('renderRows URL-encodes hrefs via quote()', () => {
  const out = renderRows([{ file: 'a file.pdf', title: 'T' }]);
  assert.match(out, /href="a%20file\.pdf"/);
});

test('buildHtml emits root-absolute brand asset paths', () => {
  const html = buildHtml([]);
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /href="\/favicon\.svg"/);
  assert.match(html, /src="\/logo\.svg"/);
  assert.doesNotMatch(html, /href="\.\.\//);
  assert.doesNotMatch(html, /src="\.\.\//);
});

test('buildHtml sets noindex meta tags', () => {
  const html = buildHtml([]);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<meta name="googlebot" content="noindex, nofollow">/);
});

// ── CLI ──────────────────────────────────────────────────────────────

test('CLI: no-op when manifest missing', () => {
  const site = makeSite();
  try {
    const r = runCli(site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no manifest\.json/);
    assert.equal(existsSync(path.join(site.refs, 'index.html')), false);
  } finally {
    site.cleanup();
  }
});

test('CLI: fails with a clear message on malformed manifest JSON', () => {
  // Regression: pre-fix, JSON.parse threw an uncaught SyntaxError with a
  // stack trace instead of a clean diagnostic. Must surface a readable
  // error on stderr and exit non-zero.
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'manifest.json'), '{ not: valid json');
    const r = runCli(site.root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /manifest\.json is not valid JSON/);
  } finally {
    site.cleanup();
  }
});

test('CLI: generates index from valid manifest', () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'brief.docx'), 'x');
    writeManifest(site.refs, {
      references: [
        {
          file: 'brief.docx',
          title: 'The Brief',
          description: 'Important stuff',
          uploaded_at: '2026-04-15',
          tags: ['shaping'],
        },
      ],
    });
    const r = runCli(site.root);
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(path.join(site.refs, 'index.html'), 'utf8');
    assert.match(html, /The Brief/);
    assert.match(html, /href="brief\.docx"/);
    assert.match(html, /Important stuff/);
    assert.match(html, /shaping/);
    assert.match(html, /2026-04-15/);
  } finally {
    site.cleanup();
  }
});

test('CLI: fails when manifest references a missing file', () => {
  const site = makeSite();
  try {
    writeManifest(site.refs, {
      references: [{ file: 'ghost.pdf', title: 'Ghost' }],
    });
    const r = runCli(site.root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /manifest references missing file: ghost\.pdf/);
  } finally {
    site.cleanup();
  }
});

test('CLI: fails when a disk file is orphaned', () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'orphan.pdf'), 'x');
    writeManifest(site.refs, { references: [] });
    const r = runCli(site.root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not listed in manifest\.json: orphan\.pdf/);
  } finally {
    site.cleanup();
  }
});

test('CLI: fails when an entry is missing its title', () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'brief.docx'), 'x');
    writeManifest(site.refs, {
      references: [{ file: 'brief.docx' }],
    });
    const r = runCli(site.root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is missing 'title'/);
  } finally {
    site.cleanup();
  }
});

test('CLI: manifest.schema.json is not flagged as an orphan', () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'manifest.schema.json'), '{}');
    writeManifest(site.refs, { references: [] });
    const r = runCli(site.root);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    site.cleanup();
  }
});

test('CLI: escapes HTML in user-supplied fields', () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'brief.docx'), 'x');
    writeManifest(site.refs, {
      references: [
        {
          file: 'brief.docx',
          title: '<script>alert(1)</script>',
          description: 'a & b',
        },
      ],
    });
    runCli(site.root);
    const html = readFileSync(path.join(site.refs, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /a &amp; b/);
  } finally {
    site.cleanup();
  }
});

test('CLI: emits root-absolute brand asset paths', () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'brief.docx'), 'x');
    writeManifest(site.refs, {
      references: [{ file: 'brief.docx', title: 'Brief' }],
    });
    runCli(site.root);
    const html = readFileSync(path.join(site.refs, 'index.html'), 'utf8');
    assert.match(html, /href="\/styles\.css"/);
    assert.match(html, /href="\/favicon\.svg"/);
    assert.match(html, /src="\/logo\.svg"/);
    assert.doesNotMatch(html, /href="\.\.\//);
    assert.doesNotMatch(html, /src="\.\.\//);
  } finally {
    site.cleanup();
  }
});

test('CLI: sorts entries by uploaded_at descending', () => {
  const site = makeSite();
  try {
    writeFileSync(path.join(site.refs, 'a.pdf'), 'x');
    writeFileSync(path.join(site.refs, 'b.pdf'), 'x');
    writeManifest(site.refs, {
      references: [
        { file: 'a.pdf', title: 'Older', uploaded_at: '2026-01-01' },
        { file: 'b.pdf', title: 'Newer', uploaded_at: '2026-04-01' },
      ],
    });
    runCli(site.root);
    const html = readFileSync(path.join(site.refs, 'index.html'), 'utf8');
    assert.ok(html.indexOf('Newer') < html.indexOf('Older'));
  } finally {
    site.cleanup();
  }
});

// ── defensive coercion (regressions) ────────────────────────────────

test('renderRows: tags as a string does not throw (coerced to empty)', () => {
  // Regression: `const tags = (e.tags) || [];` would slip a non-array
  // truthy through, then `.map` would throw. Now Array.isArray-guarded.
  const out = renderRows([
    { file: 'a.pdf', title: 'A', tags: 'foo,bar', uploaded_at: '2026-04-01' },
  ]);
  assert.match(out, /<td><a href="a\.pdf" download>A<\/a><\/td>/);
  // No tag pills should render when tags isn't an array.
  assert.ok(!out.includes('class="tag"'),
    'string tags should be ignored, not rendered as a single pill');
});

test('renderRows: tags as null does not throw', () => {
  const out = renderRows([
    { file: 'a.pdf', title: 'A', tags: null, uploaded_at: '2026-04-01' },
  ]);
  assert.match(out, /<td><a href="a\.pdf"/);
});

test('CLI: rejects manifest.references that is not an array', () => {
  // Regression: a manifest where `references` is set but is not an array
  // (typo'd as {} or "list of refs") used to slip through `|| []` and
  // crash later in renderRows with "entries.slice is not a function".
  // Now caught up front with a clear shape error.
  const site = makeSite();
  try {
    writeManifest(site.refs, { references: { not: 'an array' } });
    const r = runCli(site.root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /'references' must be an array/);
  } finally {
    site.cleanup();
  }
});
