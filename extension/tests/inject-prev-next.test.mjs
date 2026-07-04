// Unit tests for templates/search/scripts/inject-prev-next.mjs.

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
const SCRIPT = path.join(REPO_ROOT, "templates", "search", "scripts", "inject-prev-next.mjs");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures");

const mod = await import(SCRIPT);
const {
  START,
  END,
  OPT_OUT,
  flatNavEntries,
  neighborsFor,
  renderPrevNext,
  injectPrevNext,
} = mod;

const headed = (mainBody) => `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
<main>
${mainBody}
</main>
</body></html>`;

// ── flatNavEntries ──────────────────────────────────────────────────

test("flatNavEntries: top-level leaves come first, in source order", () => {
  const items = [
    { href: "a.html", label: "Alpha" },
    { href: "b.html", label: "Beta" },
    { href: "c.html", label: "Gamma" },
  ];
  assert.deepEqual(flatNavEntries(items), [
    { href: "a.html", label: "Alpha" },
    { href: "b.html", label: "Beta" },
    { href: "c.html", label: "Gamma" },
  ]);
});

test("flatNavEntries: dropdown PARENTS without href are not entries themselves", () => {
  // A nav-drop is just a label + children; the parent has no link, so
  // the prev/next sequence walks the children directly.
  const items = [
    { label: "Group", children: [
      { href: "x.html", label: "X" },
      { href: "y.html", label: "Y" },
    ]},
    { href: "z.html", label: "Z" },
  ];
  assert.deepEqual(flatNavEntries(items), [
    { href: "x.html", label: "X" },
    { href: "y.html", label: "Y" },
    { href: "z.html", label: "Z" },
  ]);
});

test("flatNavEntries: empty input -> empty output", () => {
  assert.deepEqual(flatNavEntries([]), []);
});

// ── neighborsFor ────────────────────────────────────────────────────

test("neighborsFor: middle entry -> both prev and next", () => {
  const flat = [
    { href: "a.html", label: "A" },
    { href: "b.html", label: "B" },
    { href: "c.html", label: "C" },
  ];
  const r = neighborsFor(flat, "b.html");
  assert.deepEqual(r.prev, { href: "a.html", label: "A" });
  assert.deepEqual(r.next, { href: "c.html", label: "C" });
  assert.deepEqual(r.self, { href: "b.html", label: "B" });
});

test("neighborsFor: first entry -> no prev", () => {
  const flat = [
    { href: "a.html", label: "A" },
    { href: "b.html", label: "B" },
  ];
  const r = neighborsFor(flat, "a.html");
  assert.equal(r.prev, null);
  assert.deepEqual(r.next, { href: "b.html", label: "B" });
});

test("neighborsFor: last entry -> no next", () => {
  const flat = [
    { href: "a.html", label: "A" },
    { href: "b.html", label: "B" },
  ];
  const r = neighborsFor(flat, "b.html");
  assert.deepEqual(r.prev, { href: "a.html", label: "A" });
  assert.equal(r.next, null);
});

test("neighborsFor: file not in nav -> null (caller skips)", () => {
  const flat = [{ href: "a.html", label: "A" }];
  assert.equal(neighborsFor(flat, "outside.html"), null);
});

test("neighborsFor: single-entry nav -> no neighbors at all", () => {
  // Caller (injectPrevNext) treats both prev=null AND next=null as
  // "nothing to render" so a single-page nav doesn't get an empty
  // prev/next block injected.
  const flat = [{ href: "only.html", label: "Only" }];
  const r = neighborsFor(flat, "only.html");
  assert.equal(r.prev, null);
  assert.equal(r.next, null);
});

// ── renderPrevNext ──────────────────────────────────────────────────

test("renderPrevNext: empty when both prev and next are null", () => {
  assert.equal(renderPrevNext(null, null), "");
});

test("renderPrevNext: includes Previous/Next labels and links", () => {
  const out = renderPrevNext(
    { href: "a.html", label: "Alpha" },
    { href: "c.html", label: "Gamma" },
  );
  assert.match(out, /href="a\.html"/);
  assert.match(out, /href="c\.html"/);
  assert.match(out, /Previous</);
  assert.match(out, /Next</);
  assert.match(out, /Alpha</);
  assert.match(out, /Gamma</);
  // rel attributes for SEO + accessibility.
  assert.match(out, /rel="prev"/);
  assert.match(out, /rel="next"/);
});

test("renderPrevNext: only-next produces a placeholder spacer for prev (layout stable)", () => {
  // Without a spacer, .pn-next would left-align instead of right-align
  // because flex justify-between has only one child. The spacer keeps
  // the layout consistent across first/middle/last pages.
  const out = renderPrevNext(null, { href: "next.html", label: "Next page" });
  assert.match(out, /pn-spacer/);
  assert.match(out, /href="next\.html"/);
  assert.ok(!/rel="prev"/.test(out), "no prev link rendered");
});

test("renderPrevNext: only-prev produces a placeholder spacer for next", () => {
  const out = renderPrevNext({ href: "prev.html", label: "Prev page" }, null);
  assert.match(out, /pn-spacer/);
  assert.match(out, /href="prev\.html"/);
  assert.ok(!/rel="next"/.test(out), "no next link rendered");
});

test("renderPrevNext: defaults are theme-agnostic (no dark-only rgba)", () => {
  // Real bug we just fixed: borders and hover bg used
  // rgba(255,255,255,...) which is invisible on light backgrounds.
  // Defaults should be neutral grays / currentColor so the block looks
  // OK on either theme when the host site doesn't define theme vars.
  const out = renderPrevNext(
    { href: "a.html", label: "A" },
    { href: "b.html", label: "B" },
  );
  assert.ok(!out.includes("rgba(255,255,255"), "no white-channel rgba (dark-only) defaults");
  assert.ok(!/#06f4b1/.test(out), "no hardcoded brand-green default in hover");
  // Sanity: neutral-gray rgba is the new fallback.
  assert.match(out, /rgba\(128,128,128/);
});

test("renderPrevNext: escapes HTML metacharacters in labels and hrefs", () => {
  const out = renderPrevNext(
    { href: 'a&b.html', label: 'A <b> & "C"' },
    { href: "c.html", label: "Z" },
  );
  // Attribute escaping (href).
  assert.match(out, /href="a&amp;b\.html"/);
  // Text escaping (label) - quotes don't need escaping in element text
  // content, but < > & must be escaped.
  assert.match(out, /A &lt;b&gt; &amp;/);
});

// ── injectPrevNext ──────────────────────────────────────────────────

const flat = [
  { href: "a.html", label: "A" },
  { href: "b.html", label: "B" },
  { href: "c.html", label: "C" },
];

test("injectPrevNext: inserts block just before </main>", () => {
  const html = headed("<p>middle page</p>");
  const { changed, html: out } = injectPrevNext(html, flat, "b.html");
  assert.equal(changed, true);
  // Block sits inside <main>, before </main>.
  const mainBody = out.match(/<main>([\s\S]*?)<\/main>/)[1];
  assert.ok(mainBody.includes(START));
  assert.ok(mainBody.indexOf(START) > mainBody.indexOf("middle page"),
    "block must come AFTER the main content");
});

test("injectPrevNext: idempotent on rerun", () => {
  const html = headed("<p>x</p>");
  const r1 = injectPrevNext(html, flat, "b.html");
  const r2 = injectPrevNext(r1.html, flat, "b.html");
  assert.equal(r2.changed, false);
  assert.equal(r1.html, r2.html);
});

test("injectPrevNext: rerun replaces existing block when neighbors change", () => {
  // Realistic flow: nav.json was reordered, prev/next neighbors moved.
  const html = headed("<p>x</p>");
  const r1 = injectPrevNext(html, flat, "b.html"); // a <- b -> c
  const flat2 = [
    { href: "x.html", label: "X" },
    { href: "b.html", label: "B" },
    { href: "y.html", label: "Y" },
  ];
  const r2 = injectPrevNext(r1.html, flat2, "b.html"); // x <- b -> y
  assert.equal(r2.changed, true);
  // Exactly one block, with the new neighbors.
  const starts = r2.html.match(new RegExp(START.replace(/[-/]/g, "\\$&"), "g")) ?? [];
  assert.equal(starts.length, 1);
  assert.match(r2.html, /href="x\.html"/);
  assert.match(r2.html, /href="y\.html"/);
  assert.ok(!/href="a\.html"/.test(r2.html), "old prev gone");
  assert.ok(!/href="c\.html"/.test(r2.html), "old next gone");
});

test("injectPrevNext: skips pages not in nav (e.g. 404, sitemap)", () => {
  const html = headed("<p>orphan</p>");
  const { changed, html: out } = injectPrevNext(html, flat, "outside.html");
  assert.equal(changed, false);
  assert.ok(!out.includes(START));
});

test("injectPrevNext: STRIPS prior block when page is removed from nav", () => {
  // Realistic flow: page was in nav, got injected, then removed from
  // nav.json. Next deploy must remove the stale block.
  const html = headed("<p>x</p>");
  const r1 = injectPrevNext(html, flat, "b.html");
  assert.ok(r1.html.includes(START));
  // Now b is no longer in nav.
  const flatWithoutB = flat.filter((e) => e.href !== "b.html");
  const r2 = injectPrevNext(r1.html, flatWithoutB, "b.html");
  assert.equal(r2.changed, true);
  assert.ok(!r2.html.includes(START));
});

test("injectPrevNext: respects per-page <!-- @no-prev-next --> opt-out", () => {
  const html = headed(`${OPT_OUT}\n<p>x</p>`);
  const { changed, html: out } = injectPrevNext(html, flat, "b.html");
  assert.equal(changed, false);
  assert.ok(!out.includes(START));
});

test("injectPrevNext: opt-out STRIPS a previously-injected block", () => {
  const v1 = headed("<p>x</p>");
  const r1 = injectPrevNext(v1, flat, "b.html");
  assert.ok(r1.html.includes(START));
  const v2 = r1.html.replace("<main>", `<main>\n${OPT_OUT}`);
  const r2 = injectPrevNext(v2, flat, "b.html");
  assert.equal(r2.changed, true);
  assert.ok(!r2.html.includes(START));
});

test("injectPrevNext: skips pages without </main>", () => {
  const html = `<!DOCTYPE html><html><head></head><body><p>no main</p></body></html>`;
  const { changed } = injectPrevNext(html, flat, "b.html");
  assert.equal(changed, false);
});

test("injectPrevNext: single-entry nav produces no block", () => {
  const lone = [{ href: "only.html", label: "Only" }];
  const html = headed("<p>x</p>");
  const { changed, html: out } = injectPrevNext(html, lone, "only.html");
  assert.equal(changed, false);
  assert.ok(!out.includes(START));
});

// ── CLI smoke test ──────────────────────────────────────────────────

test("CLI: inserts block on nav-listed pages, skips orphans", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pn-cli-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    // Set up a nav.json that puts about and guide in sequence.
    writeFileSync(
      path.join(docs, "nav.json"),
      JSON.stringify({
        items: [
          { href: "about.html", label: "About" },
          { href: "guide.html", label: "Guide" },
        ],
      }),
    );

    const r = spawnSync("node", [SCRIPT, "--repo", root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);

    const aboutHtml = readFileSync(path.join(docs, "about.html"), "utf8");
    const guideHtml = readFileSync(path.join(docs, "guide.html"), "utf8");
    assert.ok(aboutHtml.includes(START), "about.html should have prev/next block");
    assert.ok(guideHtml.includes(START), "guide.html should have prev/next block");
    // about is first -> no prev link to anywhere; next points to guide.
    assert.match(aboutHtml, /href="guide\.html"/);
    // guide is last -> prev points to about, no next.
    assert.match(guideHtml, /href="about\.html"/);

    // Pages NOT in nav should not be touched.
    const indexHtml = readFileSync(path.join(docs, "index.html"), "utf8");
    assert.ok(!indexHtml.includes(START), "index.html (not in nav) must not be touched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: missing nav.json is a graceful no-op (not a deploy failure)", () => {
  // A site that hasn't adopted nav.json yet shouldn't have its deploy
  // killed by enabling the prev/next add-on. Skip with status 0.
  const root = mkdtempSync(path.join(tmpdir(), "pn-no-nav-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    rmSync(path.join(docs, "nav.json"), { force: true });
    const r = spawnSync("node", [SCRIPT, "--repo", root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nav\.json not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
