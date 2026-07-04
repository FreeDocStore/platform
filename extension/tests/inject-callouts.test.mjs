// Unit tests for templates/search/scripts/inject-callouts.mjs.

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
const SCRIPT = path.join(REPO_ROOT, "templates", "search", "scripts", "inject-callouts.mjs");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures");

const mod = await import(SCRIPT);
const {
  START,
  END,
  OPT_OUT,
  PAYLOAD,
  VARIANTS,
  hasCallouts,
  injectCallouts,
} = mod;

const headed = (mainBody) => `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
<main>
${mainBody}
</main>
</body></html>`;

// ── hasCallouts ─────────────────────────────────────────────────────

test("hasCallouts: detects class=\"callout ...\" anywhere in the document", () => {
  assert.equal(hasCallouts(headed('<div class="callout note">Hi</div>')), true);
  // Variant order doesn't matter, callout can appear among other classes.
  assert.equal(hasCallouts(headed('<div class="my-thing callout warn">Hi</div>')), true);
  // Single-quote attribute style works too.
  assert.equal(hasCallouts(headed("<div class='callout tip'>Hi</div>")), true);
});

test("hasCallouts: false when there are no callouts", () => {
  assert.equal(hasCallouts(headed("<p>just prose</p>")), false);
  // Substring 'callout' inside a different class must not false-positive.
  assert.equal(hasCallouts(headed('<div class="callouter-thing">no</div>')), false);
});

test("hasCallouts: hyphen-bounded substrings are NOT false positives (regression)", () => {
  // Real bug: the previous \bcallout\b regex treated a hyphen as a
  // word boundary, so class names like "footer-callout" or
  // "my-callout-box" matched and triggered a useless CSS injection on
  // pages that didn't actually use the .callout primitive.
  assert.equal(hasCallouts(headed('<div class="footer-callout">no</div>')), false);
  assert.equal(hasCallouts(headed('<div class="my-callout-box">no</div>')), false);
  assert.equal(hasCallouts(headed('<div class="callout-trigger">no</div>')), false);
  // But a real callout among other (hyphenated) classes still matches.
  assert.equal(hasCallouts(headed('<div class="my-block callout warn">yes</div>')), true);
});

test("hasCallouts: case-insensitive on the class attribute", () => {
  // class is a case-insensitive HTML attribute. Authoring tools that
  // emit CLASS="callout" should still trigger detection.
  assert.equal(hasCallouts(headed('<div CLASS="callout note">x</div>')), true);
});

test("hasCallouts: matches even outside <main> (callouts can live anywhere)", () => {
  // Callouts in sidebars / footers should still trigger CSS injection.
  const html = `<!DOCTYPE html><html><head></head><body>
<main><p>plain</p></main>
<aside><div class="callout danger">Important sidebar note</div></aside>
</body></html>`;
  assert.equal(hasCallouts(html), true);
});

// ── injectCallouts ──────────────────────────────────────────────────

test("injectCallouts: inserts CSS payload into <head> when callouts exist", () => {
  const html = headed('<div class="callout note">x</div>');
  const { changed, html: out } = injectCallouts(html);
  assert.equal(changed, true);
  assert.match(out, new RegExp(`<head>[\\s\\S]*${START.replace(/[-/]/g, "\\$&")}[\\s\\S]*${END.replace(/[-/]/g, "\\$&")}[\\s\\S]*</head>`));
});

test("injectCallouts: idempotent on rerun", () => {
  const html = headed('<div class="callout warn">y</div>');
  const r1 = injectCallouts(html);
  const r2 = injectCallouts(r1.html);
  assert.equal(r2.changed, false);
  assert.equal(r1.html, r2.html);
});

test("injectCallouts: rerun replaces existing CSS (no stacking)", () => {
  const html = headed('<div class="callout tip">y</div>');
  const r1 = injectCallouts(html);
  const r2 = injectCallouts(r1.html);
  const starts = r2.html.match(new RegExp(START.replace(/[-/]/g, "\\$&"), "g")) ?? [];
  assert.equal(starts.length, 1, "exactly one START marker after both runs");
});

test("injectCallouts: skips pages without any callout", () => {
  const html = headed("<p>just prose</p>");
  const { changed, html: out } = injectCallouts(html);
  assert.equal(changed, false);
  assert.ok(!out.includes(START));
});

test("injectCallouts: skips pages without </head>", () => {
  // Defensive: not a real HTML page.
  const html = `<main><div class="callout warn">x</div></main>`;
  const { changed } = injectCallouts(html);
  assert.equal(changed, false);
});

test("injectCallouts: respects per-page <!-- @no-callouts --> opt-out", () => {
  const html = headed(`${OPT_OUT}\n<div class="callout note">x</div>`);
  const { changed, html: out } = injectCallouts(html);
  assert.equal(changed, false);
  assert.ok(!out.includes(START));
});

test("injectCallouts: opt-out STRIPS a previously-injected payload", () => {
  const v1 = headed('<div class="callout note">x</div>');
  const r1 = injectCallouts(v1);
  assert.ok(r1.html.includes(START));
  const v2 = r1.html.replace("<main>", `<main>\n${OPT_OUT}`);
  const r2 = injectCallouts(v2);
  assert.equal(r2.changed, true);
  assert.ok(!r2.html.includes(START));
});

test("injectCallouts: removes a stale payload when the last callout is deleted", () => {
  const v1 = headed('<div class="callout warn">x</div>');
  const r1 = injectCallouts(v1);
  // Strip the only callout - rerun should remove the now-pointless CSS.
  const v2 = r1.html.replace(/<div class="callout warn">x<\/div>/, "");
  const r2 = injectCallouts(v2);
  assert.equal(r2.changed, true);
  assert.ok(!r2.html.includes(START));
});

test("injectCallouts: PAYLOAD declares all four variant CSS rules", () => {
  // Pin the visible behaviour so a future trim can't silently drop a
  // variant rule and leave authors with unstyled .callout.danger blocks.
  for (const v of ["note", "tip", "warn", "danger"]) {
    assert.match(PAYLOAD, new RegExp(`\\.callout\\.${v}\\b`),
      `expected CSS rule for .callout.${v}`);
  }
  // info is documented as an alias for note - verify it's also styled.
  assert.match(PAYLOAD, /\.callout\.info\b/);
});

test("injectCallouts: PAYLOAD includes a styled title-row hook", () => {
  // Authors can put <strong class="callout-title">...</strong> as the
  // first child for a heading row. Pin the selector so future CSS
  // rewrites preserve it.
  assert.match(PAYLOAD, /\.callout\s*>\s*\.callout-title\b/);
});

test("VARIANTS export covers the four canonical types + the info alias", () => {
  // Future code (e.g. an extension UI) may want to enumerate variants.
  // Keep the export stable.
  assert.deepEqual(
    [...VARIANTS].sort(),
    ["danger", "info", "note", "tip", "warn"],
  );
});

// ── CLI smoke test ──────────────────────────────────────────────────

test("CLI: writes payload to qualifying pages and skips others", () => {
  const root = mkdtempSync(path.join(tmpdir(), "callouts-cli-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    const target = path.join(docs, "about.html");
    const before = readFileSync(target, "utf8")
      .replace(/<main[^>]*>/, (m) => `${m}\n<div class="callout note">CLI sample</div>`);
    writeFileSync(target, before);

    const r = spawnSync("node", [SCRIPT, "--repo", root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(target, "utf8").includes(START), "qualifying page must have a payload");
    // Pages without callouts stay untouched.
    const indexAfter = readFileSync(path.join(docs, "index.html"), "utf8");
    assert.ok(!indexAfter.includes(START), "non-qualifying page must NOT be touched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
