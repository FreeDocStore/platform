// Unit tests for templates/search/scripts/lib/inject-utils.mjs.
// These helpers are now consumed by every inject-*.mjs script - any
// behavioural drift here breaks several add-ons at once, so the
// regression bar is high.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LIB = path.join(REPO_ROOT, "templates", "search", "scripts", "lib", "inject-utils.mjs");

const {
  escapeText,
  escapeAttr,
  escapeRegExp,
  stripBlockBetween,
  replaceOrInsertBlock,
} = await import(LIB);

// ── escape helpers ──────────────────────────────────────────────────

test("escapeText: escapes & < > but not quotes (text content rules)", () => {
  assert.equal(escapeText("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  assert.equal(escapeText('with "quotes" and \'apos\''), 'with "quotes" and \'apos\'',
    "quotes don't need escaping in element text content");
});

test("escapeText: ampersand-first ordering avoids double-encoding", () => {
  // Real bug if & is not escaped first: escaping < to &lt; then & to
  // &amp; turns the original "a < b" into "a &amp;lt; b" - ampersand
  // would over-eat the lt entity.
  assert.equal(escapeText("a < b"), "a &lt; b");
  assert.equal(escapeText("a &lt; b"), "a &amp;lt; b",
    "an existing entity gets ampersand-escaped, NOT decoded");
});

test("escapeAttr: escapes & < > \" ' (attribute-context rules)", () => {
  assert.equal(escapeAttr('a"b\'c<d>e&f'), "a&quot;b&#x27;c&lt;d&gt;e&amp;f");
});

test("escapeRegExp: escapes every regex metacharacter", () => {
  // Pin every metachar so a regex built from user input can't trigger
  // unexpected pattern behaviour.
  for (const ch of [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]) {
    const escaped = escapeRegExp(ch);
    // Round-trip: the escaped pattern must match exactly the literal char.
    assert.match(ch, new RegExp(escaped), `${ch} round-trip`);
  }
});

test("escapeRegExp: leaves ordinary chars alone", () => {
  assert.equal(escapeRegExp("hello-world_123"), "hello-world_123");
});

// ── marker block: stripBlockBetween ─────────────────────────────────

const START = "<!-- @x -->";
const END = "<!-- /@x -->";

test("stripBlockBetween: removes a single block + the surrounding newlines", () => {
  // The strip pattern consumes one newline on each side of the block
  // so files don't end up with an empty line where the injection used
  // to be. `<head>\nBLOCK\n</head>` collapses to `<head></head>`.
  const html = `<head>\n${START}\nbody\n${END}\n</head>`;
  const out = stripBlockBetween(html, START, END);
  assert.equal(out, `<head></head>`);
});

test("stripBlockBetween: no block present -> returns html unchanged", () => {
  const html = `<head></head>`;
  assert.equal(stripBlockBetween(html, START, END), html);
});

test("stripBlockBetween: tolerates marker strings with regex metacharacters", () => {
  // The marker strings DO contain `<`, `-`, `/`, `@` - escapeRegExp
  // must escape them or the regex would over-match. Defensive test
  // pins this property for arbitrary marker shapes.
  const oddStart = "<!-- @[odd] -->";
  const oddEnd = "<!-- /@[odd] -->";
  const html = `head\n${oddStart}\npayload\n${oddEnd}\ntail`;
  // strip consumes one surrounding newline on each side - the goal is
  // a tidy result with no blank line where the block used to be.
  assert.equal(stripBlockBetween(html, oddStart, oddEnd), `headtail`);
});

// ── marker block: replaceOrInsertBlock ──────────────────────────────

test("replaceOrInsertBlock: inserts after the anchor when no block exists", () => {
  const html = `<head><title>x</title></head><body></body>`;
  const r = replaceOrInsertBlock(html, START, END, `${START}\nNEW\n${END}`, /<\/head>/i);
  assert.equal(r.changed, true);
  assert.match(r.html, /<\/head>\n<!-- @x -->\nNEW\n<!-- \/@x -->/);
});

test("replaceOrInsertBlock: inserts BEFORE the anchor when opts.before=true", () => {
  // The before-anchor path is what every <head>-injection script uses
  // (insert before </head>). Pin the behaviour explicitly.
  const html = `<head><title>x</title></head>`;
  const payload = `${START}\nP\n${END}`;
  const r = replaceOrInsertBlock(html, START, END, payload, /<\/head>/i, { before: true });
  assert.match(r.html, new RegExp(`${escapeRegExp(payload)}\\n</head>`));
});

test("replaceOrInsertBlock: replaces an existing block in place (no stacking)", () => {
  const html = `<head>\n${START}\nold\n${END}\n</head>`;
  const r = replaceOrInsertBlock(html, START, END, `${START}\nnew\n${END}`, /<\/head>/i);
  assert.equal(r.changed, true);
  // Exactly one block survives.
  const starts = r.html.match(new RegExp(escapeRegExp(START), "g")) ?? [];
  assert.equal(starts.length, 1);
  assert.match(r.html, /\nnew\n/);
  assert.ok(!r.html.includes("\nold\n"));
});

test("replaceOrInsertBlock: idempotent when payload matches existing block", () => {
  const payload = `${START}\nsame\n${END}`;
  const html = `<head>\n${payload}\n</head>`;
  const r = replaceOrInsertBlock(html, START, END, payload, /<\/head>/i);
  assert.equal(r.changed, false, "no change when payload matches existing block");
  assert.equal(r.html, html);
});

test("replaceOrInsertBlock: no anchor + no block -> changed:false (page is left alone)", () => {
  const html = `<body>nothing here</body>`;
  const r = replaceOrInsertBlock(html, START, END, `${START}\nP\n${END}`, /<\/head>/i);
  assert.equal(r.changed, false);
  assert.equal(r.html, html);
});

test("replaceOrInsertBlock: anchor regex matches case-insensitively when /i is set", () => {
  // Mirrors how the inject scripts use /<\/head>/i. HTML tag names
  // are case-insensitive, so the helper must respect the regex flags
  // the caller passes in.
  const html = `<HEAD></HEAD>`;
  const r = replaceOrInsertBlock(html, START, END, `${START}\nP\n${END}`, /<\/head>/i, { before: true });
  assert.equal(r.changed, true);
});
