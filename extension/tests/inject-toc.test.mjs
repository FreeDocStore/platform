// Unit tests for templates/search/scripts/inject-toc.mjs.
//
// We import the module directly (no bundling needed - it's plain ESM
// targeting Node and has no chrome.* deps).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "templates", "search", "scripts", "inject-toc.mjs");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures");

const mod = await import(SCRIPT);
const {
  START,
  END,
  OPT_OUT,
  MIN_HEADINGS,
  PLACEMENTS,
  slugify,
  extractHeadings,
  ensureIds,
  renderToc,
  injectToc,
} = mod;

// ── slugify ─────────────────────────────────────────────────────────

test("slugify: lowercase, dashes, strips punctuation and tags", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("Foo, Bar! Baz?"), "foo-bar-baz");
  assert.equal(slugify("<code>fn()</code> calls"), "fn-calls");
  assert.equal(slugify("&amp; entities"), "entities");
  // Empty/whitespace -> empty so caller can skip rather than emit "".
  assert.equal(slugify(""), "");
  assert.equal(slugify("   "), "");
});

test("slugify: strips numeric HTML entities (regression: was leaking digits)", () => {
  // Real bug: the previous /&[a-z]+;/gi pattern only stripped NAMED
  // entities, so "Don&#39;t" produced "don39t" - the numeric digits
  // leaked through as part of the slug. Now strips both named and
  // numeric forms by replacing them with whitespace (so &nbsp; doesn't
  // accidentally join two words). The slug then collapses runs of
  // whitespace into single dashes.
  assert.equal(slugify("Don&#39;t"), "don-t");
  assert.equal(slugify("A &#x27;quote&#x27; here"), "a-quote-here");
  assert.equal(slugify("100&nbsp;percent &mdash; done"), "100-percent-done");
  // Critically: digits from numeric entities don't leak into the slug.
  assert.ok(!slugify("Don&#39;t").includes("39"), "no digit leak from &#39;");
  assert.ok(!slugify("&#x27;hi&#x27;").includes("27"), "no hex leak from &#x27;");
});

// ── extractHeadings ─────────────────────────────────────────────────

test("extractHeadings: returns empty when there's no <main>", () => {
  const html = "<html><body><h2>Hi</h2></body></html>";
  const r = extractHeadings(html);
  assert.deepEqual(r.headings, []);
  assert.equal(r.html, html);
});

test("extractHeadings: collects h2 and h3 inside <main> in source order", () => {
  const html = `<html><body>
    <main>
      <h2 id="foo">Foo</h2>
      <p>x</p>
      <h3 id="foo-detail">Foo detail</h3>
      <h2 id="bar">Bar</h2>
    </main>
  </body></html>`;
  const r = extractHeadings(html);
  assert.deepEqual(
    r.headings.map((h) => ({ level: h.level, id: h.id, text: h.text })),
    [
      { level: 2, id: "foo", text: "Foo" },
      { level: 3, id: "foo-detail", text: "Foo detail" },
      { level: 2, id: "bar", text: "Bar" },
    ],
  );
});

test("extractHeadings: skips h1/h4 (only h2 and h3)", () => {
  const html = `<main>
    <h1>Page title</h1>
    <h2 id="a">A</h2>
    <h4>Tiny</h4>
  </main>`;
  const r = extractHeadings(html);
  assert.deepEqual(r.headings.map((h) => h.text), ["A"]);
});

test("extractHeadings: ignores headings outside <main> (e.g. sidebar h2 like 'On this page')", () => {
  const html = `<html><body>
    <nav class="sidebar"><h2>Sidebar title</h2></nav>
    <main>
      <h2>Real heading</h2>
    </main>
  </body></html>`;
  const r = extractHeadings(html);
  assert.deepEqual(r.headings.map((h) => h.text), ["Real heading"]);
});

test("extractHeadings: proposes slugs but does NOT mutate html (read-only scan)", () => {
  // Pure scan so pages that won't get a TOC stay byte-identical.
  // ensureIds is the separate function that commits the proposals.
  const html = `<main>
    <h2>First Section</h2>
    <h2>Second Section</h2>
  </main>`;
  const r = extractHeadings(html);
  assert.deepEqual(r.headings.map((h) => h.id), ["first-section", "second-section"]);
  assert.deepEqual(r.headings.map((h) => h.hasId), [false, false]);
  assert.equal(r.html, html, "html is NOT mutated by extractHeadings");
});

test("extractHeadings: avoids id collisions with existing ids on the page", () => {
  const html = `<main>
    <p id="intro">Intro</p>
    <h2>Intro</h2>
  </main>`;
  const r = extractHeadings(html);
  // "intro" is taken by the <p>, so the proposed slug becomes "intro-2".
  assert.equal(r.headings[0].id, "intro-2");
  assert.equal(r.headings[0].hasId, false);
});

test("extractHeadings: avoids collisions among auto-generated ids in the same file", () => {
  const html = `<main>
    <h2>Setup</h2>
    <h3>Setup</h3>
    <h2>Setup</h2>
  </main>`;
  const r = extractHeadings(html);
  assert.deepEqual(r.headings.map((h) => h.id), ["setup", "setup-2", "setup-3"]);
});

test("extractHeadings: existing ids are preserved (hasId=true)", () => {
  const html = `<main>
    <h2 id="custom-anchor">Custom</h2>
    <h2>Auto</h2>
  </main>`;
  const r = extractHeadings(html);
  assert.deepEqual(
    r.headings.map((h) => ({ id: h.id, hasId: h.hasId })),
    [{ id: "custom-anchor", hasId: true }, { id: "auto", hasId: false }],
  );
});

// ── ensureIds (separate commit step) ────────────────────────────────

test("ensureIds: writes proposed ids onto headings that lacked one", () => {
  const html = `<main>
<h2>Alpha</h2>
<h2 id="beta">Beta</h2>
</main>`;
  const { headings } = extractHeadings(html);
  const out = ensureIds(html, headings);
  assert.match(out, /<h2 id="alpha">Alpha<\/h2>/);
  assert.match(out, /<h2 id="beta">Beta<\/h2>/);
});

test("ensureIds: no-op when every heading already has an id", () => {
  const html = `<main>
<h2 id="a">A</h2>
<h2 id="b">B</h2>
</main>`;
  const { headings } = extractHeadings(html);
  const out = ensureIds(html, headings);
  assert.equal(out, html);
});

// ── renderToc ───────────────────────────────────────────────────────

test("renderToc: returns empty string under MIN_HEADINGS", () => {
  assert.equal(renderToc([]), "");
  assert.equal(renderToc([{ level: 2, id: "a", text: "A" }]), "");
});

test("renderToc: produces a nested-flat list with anchor links", () => {
  const out = renderToc([
    { level: 2, id: "intro", text: "Intro" },
    { level: 3, id: "intro-detail", text: "Intro detail" },
    { level: 2, id: "next", text: "Next" },
  ]);
  assert.match(out, new RegExp(`^${START.replace(/[-/]/g, "\\$&")}`));
  assert.match(out, new RegExp(`${END.replace(/[-/]/g, "\\$&")}$`));
  assert.match(out, /<a href="#intro">Intro<\/a>/);
  assert.match(out, /<a href="#intro-detail">Intro detail<\/a>/);
  assert.match(out, /class="toc-sub"/);
});

test("renderToc: escapes HTML metacharacters in heading text", () => {
  // Real heading content can include code samples (<code>, <fn>) so the
  // rendered link text must escape <, >, and &. Quotes don't need
  // escaping in element text content (only in attribute values).
  const out = renderToc([
    { level: 2, id: "tags", text: "Tags <like> & this" },
    { level: 2, id: "next", text: "Next" },
  ]);
  assert.ok(!out.includes("<like>"), "raw < should be escaped");
  assert.match(out, /Tags &lt;like&gt; &amp; this/);
});

test("renderToc: rail placement adds the auto-toc-rail class and a sticky CSS rule", () => {
  // The rail variant is the canonical software-docs "On this page"
  // sticky right-side panel. Pin the marker class + the @media-gated
  // sticky/float rules so a future CSS rewrite can't silently regress
  // back to a banner-only mode.
  const out = renderToc(
    [
      { level: 2, id: "a", text: "A" },
      { level: 2, id: "b", text: "B" },
    ],
    "rail",
  );
  assert.match(out, /class="auto-toc auto-toc-rail"/);
  assert.match(out, /position:\s*sticky/);
  assert.match(out, /float:\s*right/);
  assert.match(out, /@media\s*\(min-width:\s*1024px\)/);
});

test("renderToc: inline placement (default) does NOT add the rail class", () => {
  const out = renderToc(
    [
      { level: 2, id: "a", text: "A" },
      { level: 2, id: "b", text: "B" },
    ],
    "inline",
  );
  assert.ok(!out.includes("auto-toc-rail"), "inline mode must not include rail class");
  // Default (no placement arg) behaves as inline.
  const def = renderToc(
    [
      { level: 2, id: "a", text: "A" },
      { level: 2, id: "b", text: "B" },
    ],
  );
  assert.ok(!def.includes("auto-toc-rail"), "default placement is inline");
});

test("PLACEMENTS export covers the two valid values", () => {
  assert.deepEqual([...PLACEMENTS].sort(), ["inline", "rail"]);
});

test("renderToc: escapes special characters in heading id (attribute escaping)", () => {
  // Defensive: an id containing & or " would corrupt the href attribute
  // if not escaped. Real-world ids should never look like this, but
  // verify the path is safe anyway.
  const out = renderToc([
    { level: 2, id: 'a"b&c', text: "X" },
    { level: 2, id: "y", text: "Y" },
  ]);
  assert.match(out, /href="#a&quot;b&amp;c"/);
});

// ── injectToc (idempotency, opt-out, full pipeline) ─────────────────

test("injectToc: inserts a TOC just inside <main>", () => {
  const html = `<html><body>
<main>
<h2>Alpha</h2>
<p>x</p>
<h2>Beta</h2>
</main>
</body></html>`;
  const { changed, html: out } = injectToc(html);
  assert.equal(changed, true);
  // The TOC block should be inside <main>, before the first <h2>.
  const mainBody = out.match(/<main>([\s\S]*?)<\/main>/)[1];
  assert.ok(mainBody.indexOf(START) < mainBody.indexOf("<h2"),
    "TOC block must precede the first heading inside <main>");
});

test("injectToc: idempotent on rerun", () => {
  const html = `<main>
<h2>Alpha</h2>
<h2>Beta</h2>
</main>`;
  const first = injectToc(html);
  const second = injectToc(first.html);
  assert.equal(second.changed, false, "second run must be a no-op");
  assert.equal(first.html, second.html);
});

test("injectToc: replaces existing TOC block on rerun when headings change", () => {
  const v1 = `<main>
<h2>Alpha</h2>
<h2>Beta</h2>
</main>`;
  const r1 = injectToc(v1);
  // Mutate ONLY the heading text (replaceAll catches both heading + TOC
  // link occurrences). The rerun's regenerated TOC should match the
  // new heading text, and there must still be exactly one TOC block.
  const v2 = r1.html.replaceAll("Alpha", "Apple").replaceAll("Beta", "Banana");
  const r2 = injectToc(v2);
  // Exactly one TOC block, no stacking.
  const tocStarts = r2.html.match(new RegExp(START.replace(/[-/]/g, "\\$&"), "g")) ?? [];
  assert.equal(tocStarts.length, 1, "exactly one TOC marker after rerun");
  // The TOC reflects the new heading text.
  const tocBlock = r2.html.match(new RegExp(`${START.replace(/[-/]/g, "\\$&")}([\\s\\S]*?)${END.replace(/[-/]/g, "\\$&")}`))[1];
  assert.match(tocBlock, /Apple/);
  assert.match(tocBlock, /Banana/);
});

test("injectToc: respects per-page <!-- @no-toc --> opt-out", () => {
  const html = `<main>
${OPT_OUT}
<h2>A</h2>
<h2>B</h2>
</main>`;
  const { changed, html: out } = injectToc(html);
  assert.equal(changed, false);
  assert.ok(!out.includes(START), "no TOC injected when opt-out marker is present");
});

test("injectToc: opt-out STRIPS a previously-injected TOC", () => {
  // Realistic flow: page had TOC, author later added @no-toc -> next
  // deploy must remove the stale block.
  const v1 = `<main>
<h2>A</h2>
<h2>B</h2>
</main>`;
  const r1 = injectToc(v1);
  assert.ok(r1.html.includes(START), "sanity: v1 produces a TOC");
  const v2 = r1.html.replace("<main>", `<main>\n${OPT_OUT}`);
  const r2 = injectToc(v2);
  assert.equal(r2.changed, true);
  assert.ok(!r2.html.includes(START), "TOC must be stripped when opt-out is added later");
});

test("injectToc: skip pages under MIN_HEADINGS (only one h2)", () => {
  const html = `<main>
<h2>Only one</h2>
</main>`;
  const { changed, html: out } = injectToc(html);
  assert.equal(changed, false);
  assert.ok(!out.includes(START));
});

test("injectToc: removes a stale TOC when headings drop below threshold", () => {
  const v1 = `<main>
<h2>A</h2>
<h2>B</h2>
</main>`;
  const r1 = injectToc(v1);
  // After r1 the headings have auto-injected ids (e.g. <h2 id="b">B</h2>),
  // so match the heading flexibly instead of a literal `<h2>B</h2>`.
  const v2 = r1.html.replace(/<h2[^>]*>B<\/h2>/, "");
  const r2 = injectToc(v2);
  assert.equal(r2.changed, true);
  assert.ok(!r2.html.includes(START));
});

test("injectToc: skips pages without <main>", () => {
  const html = `<html><body><h2>A</h2><h2>B</h2></body></html>`;
  const { changed } = injectToc(html);
  assert.equal(changed, false);
});

// ── CLI smoke test on a temp fixture ────────────────────────────────

test("CLI: --placement rail produces the sticky right-rail variant", () => {
  const root = mkdtempSync(path.join(tmpdir(), "toc-rail-cli-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    const target = path.join(docs, "about.html");
    const before = readFileSync(target, "utf8")
      .replace(/<main[^>]*>/, (m) => `${m}\n<h2>Section A</h2>\n<p>x</p>\n<h2>Section B</h2>`);
    writeFileSync(target, before);

    const r = spawnSync("node", [SCRIPT, "--repo", root, "--placement", "rail"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(target, "utf8");
    assert.match(after, /auto-toc-rail/, "rail variant must be rendered");
    assert.match(after, /position:\s*sticky/, "sticky CSS must be present");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: invalid --placement exits non-zero with a helpful message", () => {
  // Defensive: the workflow passes whatever features.json says. A
  // typo'd "raul" instead of "rail" should fail loudly at deploy
  // time, not silently fall back to inline (which would mask the
  // misconfiguration).
  const r = spawnSync("node", [SCRIPT, "--placement", "raul"], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "should exit non-zero on bad placement");
  assert.match(r.stderr, /invalid --placement/);
});

test("CLI: writes TOC to qualifying pages and skips others (end-to-end)", () => {
  // Build a tiny site under a temp dir so we don't touch real fixtures.
  const root = mkdtempSync(path.join(tmpdir(), "toc-cli-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    // Force a page to qualify by giving it 2 h2s.
    const target = path.join(docs, "about.html");
    const before = readFileSync(target, "utf8")
      .replace(/<main[^>]*>/, (m) => `${m}\n<h2>Section A</h2>\n<p>x</p>\n<h2>Section B</h2>`);
    writeFileSync(target, before);

    const r = spawnSync("node", [SCRIPT, "--repo", root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(target, "utf8");
    assert.ok(after.includes(START), "qualifying page must have a TOC");
    // Heading should now have an id.
    assert.match(after, /<h2 id="section-a">Section A<\/h2>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
