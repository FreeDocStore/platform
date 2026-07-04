// Unit tests for templates/search/scripts/inject-codeblocks.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "templates", "search", "scripts", "inject-codeblocks.mjs");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures");

const mod = await import(SCRIPT);
const {
  START,
  END,
  OPT_OUT,
  PAYLOAD,
  ASSET_FILES,
  hasCodeBlocks,
  injectCodeblocks,
  installAssets,
} = mod;

// Minimal page templates - kept inline because the existing fixtures
// don't all have <pre> blocks and we want predictable shapes.
const headed = (mainBody) => `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
<main>
${mainBody}
</main>
</body></html>`;

// ── hasCodeBlocks ───────────────────────────────────────────────────

test("hasCodeBlocks: true when <pre> appears inside <main>", () => {
  assert.equal(hasCodeBlocks(headed("<pre><code>x</code></pre>")), true);
  // Attribute on <pre> still matches.
  assert.equal(hasCodeBlocks(headed('<pre class="lang-go"><code>x</code></pre>')), true);
});

test("hasCodeBlocks: false when there's no <main>", () => {
  assert.equal(
    hasCodeBlocks("<html><body><pre><code>x</code></pre></body></html>"),
    false,
  );
});

test("hasCodeBlocks: false when <pre> is outside <main> (e.g. footer/sidebar)", () => {
  // We only decorate code in main content. A <pre> in a footer or a
  // theme-injected script tag region shouldn't count.
  const html = `<!DOCTYPE html><html><head></head><body>
<header><pre>nope</pre></header>
<main><p>plain prose with no code</p></main>
<footer><pre>also nope</pre></footer>
</body></html>`;
  assert.equal(hasCodeBlocks(html), false);
});

test("hasCodeBlocks: case-insensitive on tag names (regression)", () => {
  // HTML tag names are case-insensitive. Authoring tools that emit
  // <PRE> or <Main> still produce real <pre> elements at runtime, so
  // they must trigger detection. The previous case-sensitive regex
  // missed both forms.
  assert.equal(hasCodeBlocks(headed("<PRE>uppercase</PRE>")), true);
  assert.equal(
    hasCodeBlocks('<html><head></head><body><Main><pre>x</pre></Main></body></html>'),
    true,
  );
});

test("hasCodeBlocks: matches <pre class=\"language-foo\"> directly (Prism alt format)", () => {
  // Prism accepts both `<pre><code class="language-foo">` and the
  // shorter `<pre class="language-foo">`. Both should trigger our
  // payload injection so the second form gets highlighted too.
  assert.equal(
    hasCodeBlocks(headed('<pre class="language-bash">echo hi</pre>')),
    true,
  );
});

// ── injectCodeblocks ────────────────────────────────────────────────

test("injectCodeblocks: inserts payload into <head> when there's a <pre> in <main>", () => {
  const html = headed("<pre><code>npm test</code></pre>");
  const { changed, html: out } = injectCodeblocks(html);
  assert.equal(changed, true);
  // Payload lives between START and END markers, inside <head>.
  assert.match(out, new RegExp(`<head>[\\s\\S]*${START.replace(/[-/]/g, "\\$&")}[\\s\\S]*${END.replace(/[-/]/g, "\\$&")}[\\s\\S]*</head>`));
});

test("injectCodeblocks: idempotent on rerun (same input -> same output)", () => {
  const html = headed("<pre><code>foo</code></pre>");
  const r1 = injectCodeblocks(html);
  const r2 = injectCodeblocks(r1.html);
  assert.equal(r2.changed, false);
  assert.equal(r1.html, r2.html);
});

test("injectCodeblocks: rerun replaces existing payload (no stacking)", () => {
  const html = headed("<pre><code>foo</code></pre>");
  const r1 = injectCodeblocks(html);
  const r2 = injectCodeblocks(r1.html);
  // Exactly one START marker after both runs.
  const starts = r2.html.match(new RegExp(START.replace(/[-/]/g, "\\$&"), "g")) ?? [];
  assert.equal(starts.length, 1);
});

test("injectCodeblocks: skips pages without a <pre> in <main>", () => {
  const html = headed("<p>just prose</p>");
  const { changed, html: out } = injectCodeblocks(html);
  assert.equal(changed, false);
  assert.ok(!out.includes(START));
});

test("injectCodeblocks: skips pages without <main>", () => {
  const html = "<html><head></head><body><pre><code>x</code></pre></body></html>";
  const { changed, html: out } = injectCodeblocks(html);
  assert.equal(changed, false);
  assert.ok(!out.includes(START));
});

test("injectCodeblocks: skips pages without </head>", () => {
  // Defensive: not a real HTML page, don't touch it.
  const html = `<main><pre>x</pre></main>`;
  const { changed } = injectCodeblocks(html);
  assert.equal(changed, false);
});

test("injectCodeblocks: respects per-page <!-- @no-codeblocks --> opt-out", () => {
  const html = headed(`${OPT_OUT}\n<pre><code>foo</code></pre>`);
  const { changed, html: out } = injectCodeblocks(html);
  assert.equal(changed, false);
  assert.ok(!out.includes(START));
});

test("injectCodeblocks: opt-out STRIPS a previously-injected payload", () => {
  // Realistic flow: page had codeblocks, author later added @no-codeblocks
  // -> next deploy must remove the stale block.
  const v1 = headed("<pre><code>foo</code></pre>");
  const r1 = injectCodeblocks(v1);
  assert.ok(r1.html.includes(START), "sanity: v1 produces a payload");
  const v2 = r1.html.replace("<main>", `<main>\n${OPT_OUT}`);
  const r2 = injectCodeblocks(v2);
  assert.equal(r2.changed, true);
  assert.ok(!r2.html.includes(START));
});

test("injectCodeblocks: removes a stale payload when the last <pre> is deleted", () => {
  // Page that had code earlier shouldn't keep loading the script
  // forever after the prose was rewritten without a code sample.
  const v1 = headed("<pre><code>x</code></pre>");
  const r1 = injectCodeblocks(v1);
  const v2 = r1.html.replace(/<pre[^>]*>[\s\S]*?<\/pre>/, "");
  const r2 = injectCodeblocks(v2);
  assert.equal(r2.changed, true);
  assert.ok(!r2.html.includes(START));
});

test("injectCodeblocks: payload includes the Copy button text and a clipboard branch", () => {
  // Pin the visible behaviour so a future refactor can't silently
  // drop the user-visible affordance or the navigator.clipboard path.
  assert.match(PAYLOAD, /textContent\s*=\s*"Copy"/, "Copy button label must be present");
  assert.match(PAYLOAD, /navigator\.clipboard\.writeText/);
  // Fallback for environments without async clipboard API.
  assert.match(PAYLOAD, /document\.execCommand\("copy"\)/);
});

test("injectCodeblocks: payload loads self-hosted Prism (no CDN, no CSP changes)", () => {
  // Pin the self-hosted asset paths so we can't accidentally regress
  // to a CDN URL (which would need a CSP allowance every site has to
  // adopt). The href/src must be root-absolute so it works on every
  // page regardless of nesting depth.
  assert.match(PAYLOAD, /href="\/codeblocks\/prism\.min\.css"/);
  assert.match(PAYLOAD, /src="\/codeblocks\/prism-bundle\.min\.js"/);
  // No external (cdnjs / jsdelivr / unpkg) URLs.
  assert.ok(!/cdnjs\.cloudflare\.com/.test(PAYLOAD));
  assert.ok(!/cdn\.jsdelivr\.net/.test(PAYLOAD));
  assert.ok(!/unpkg\.com/.test(PAYLOAD));
});

test("injectCodeblocks: copy-button defaults are theme-agnostic", () => {
  // Real bug we just fixed: copy button used hardcoded dark colors
  // (#444, #1e1e1e, #ccc) so it looked wrong on light Prism themes.
  // Defaults should be neutral rgba / currentColor so it adapts.
  assert.ok(!/#1e1e1e/.test(PAYLOAD), "no hardcoded dark bg default");
  assert.ok(!/#ccc\b/.test(PAYLOAD), "no hardcoded light text default");
  assert.ok(!/, #444\)/.test(PAYLOAD), "no hardcoded dark border default");
  assert.match(PAYLOAD, /rgba\(128,128,128/, "neutral-gray fallback in use");
});

test("injectCodeblocks: payload includes FOUC guard for language-tagged blocks", () => {
  // Without the guard, language-tagged code briefly shows unhighlighted
  // before Prism's defer-loaded bundle finishes. The guard hides only
  // language-tagged blocks (plain <pre> still renders immediately) and
  // gets removed by the init handler at DOMContentLoaded - ensuring
  // that even on a Prism load failure, code falls back to visible plain
  // text within the first paint.
  assert.match(PAYLOAD, /<style id="cb-fouc">/);
  assert.match(PAYLOAD, /pre\[class\*="language-"\]\s*\{\s*visibility:\s*hidden/);
  // The init handler must remove the guard, otherwise content stays
  // hidden forever.
  assert.match(PAYLOAD, /getElementById\("cb-fouc"\)/);
});

// ── installAssets ───────────────────────────────────────────────────

test("installAssets: copies vendored Prism files into docs/codeblocks/", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cb-assets-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });

    installAssets(docs);

    const codeblocksDir = path.join(docs, "codeblocks");
    for (const f of ASSET_FILES) {
      const dest = path.join(codeblocksDir, f);
      assert.ok(
        readFileSync(dest, "utf8").length > 0,
        `expected ${f} copied to docs/codeblocks/`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installAssets: idempotent (safe to rerun, second call overwrites)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cb-assets-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    installAssets(docs);
    // Second call must not throw and must leave the same files in place.
    installAssets(docs);
    for (const f of ASSET_FILES) {
      assert.ok(readFileSync(path.join(docs, "codeblocks", f), "utf8").length > 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installAssets: throws clearly when vendored source is missing", () => {
  // Defensive: a botched checkout / partial vendor would otherwise
  // produce a broken site (script tags pointing at 404). Surface the
  // failure loudly at deploy time instead.
  const root = mkdtempSync(path.join(tmpdir(), "cb-assets-bad-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    const emptySrc = mkdtempSync(path.join(tmpdir(), "cb-empty-"));
    assert.throws(
      () => installAssets(docs, emptySrc),
      /Vendored Prism asset missing/,
    );
    rmSync(emptySrc, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── CLI smoke test on a temp fixture ────────────────────────────────

test("CLI: writes payload to qualifying pages and skips others (end-to-end)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codeblocks-cli-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    // Force a page to qualify by adding a <pre> in <main>.
    const target = path.join(docs, "about.html");
    const before = readFileSync(target, "utf8")
      .replace(/<main[^>]*>/, (m) => `${m}\n<pre><code>cli sample</code></pre>`);
    writeFileSync(target, before);

    const r = spawnSync("node", [SCRIPT, "--repo", root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);

    const after = readFileSync(target, "utf8");
    assert.ok(after.includes(START), "qualifying page must have a payload");

    // A page without <pre> stays untouched.
    const indexAfter = readFileSync(path.join(docs, "index.html"), "utf8");
    assert.ok(!indexAfter.includes(START), "non-qualifying page must NOT be touched");

    // Prism assets must be installed when at least one page qualifies,
    // otherwise the injected <link>+<script> tags 404 in production.
    for (const f of ASSET_FILES) {
      assert.ok(
        readFileSync(path.join(docs, "codeblocks", f), "utf8").length > 0,
        `expected docs/codeblocks/${f} after CLI run`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: skips asset install when no page has a code block", () => {
  // Sites without any <pre> in <main> shouldn't get a stray
  // /codeblocks/ directory polluting their deploy.
  const root = mkdtempSync(path.join(tmpdir(), "codeblocks-cli-noop-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    // The fixture's sample_site has no <pre> blocks - leave as-is.
    const r = spawnSync("node", [SCRIPT, "--repo", root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      !readdirSync(docs).includes("codeblocks"),
      "no /codeblocks/ directory when no page qualifies",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
