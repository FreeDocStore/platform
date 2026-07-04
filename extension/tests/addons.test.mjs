// Tests for the add-ons catalog + system-prompt block formatter.
// Catalog itself ships as JSON in templates/add-ons.json - validating
// shape here means a future edit that drops a required field, breaks
// the schema, or leaks a copy-paste config snippet (per VISION) fails
// the test suite immediately.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./_bundle.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CATALOG_PATH = path.join(REPO_ROOT, "templates", "add-ons.json");

const { ADDONS, getAddOn, formatAddonsBlock } = await import(
  await bundle("src/lib/addons.ts")
);

// ── catalog shape ───────────────────────────────────────────────────

test("catalog is non-empty", () => {
  assert.ok(ADDONS.length > 0, "expected at least one add-on in the catalog");
});

test("every catalog entry has the required fields", () => {
  for (const a of ADDONS) {
    assert.equal(typeof a.key, "string", `bad key: ${JSON.stringify(a)}`);
    assert.ok(a.key.length > 0, `empty key: ${JSON.stringify(a)}`);
    assert.equal(typeof a.name, "string", `bad name on ${a.key}`);
    assert.equal(typeof a.description, "string", `bad description on ${a.key}`);
    assert.equal(typeof a.generates, "string", `bad generates on ${a.key}`);
    assert.ok(Array.isArray(a.askPrompts), `askPrompts must be an array on ${a.key}`);
    for (const p of a.askPrompts) {
      assert.equal(typeof p, "string");
      assert.ok(p.length > 0);
    }
  }
});

test("catalog keys are unique", () => {
  const keys = ADDONS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate add-on key in catalog");
});

test("catalog has no copy-paste config snippets (VISION rule)", () => {
  // Add-ons are toggled ONLY by the chat agent. A snippet in a
  // description, generates, or askPrompt would invite hand-edits and
  // bypass the chat-driven flow. Catch any of: features.json mention
  // outside the official "ask the agent" framing, JSON braces, the
  // "add this line" / "set X to true" pattern, --workflow-flag style.
  const FORBIDDEN = [
    /\bset\s+["'`]?\w+["'`]?\s*[:=]\s*true\b/i,
    /\badd\s+(?:this\s+)?line\b/i,
    /\bedit\s+(?:docs\/)?features\.json\b/i,
    /^\s*[{}]\s*$/m, // raw JSON brace lines
    /^\s*"\w+"\s*:\s*true,?\s*$/m, // raw "key": true lines
    /--enable-\w+/, // workflow flags
  ];
  for (const a of ADDONS) {
    const haystack = [a.description, a.generates, ...a.askPrompts].join("\n");
    for (const re of FORBIDDEN) {
      assert.ok(!re.test(haystack), `add-on '${a.key}' contains forbidden snippet pattern ${re}`);
    }
  }
});

test("catalog file in templates/ is the source of truth (matches bundled)", () => {
  // Sanity: the shipped extension's catalog must match the file in
  // templates/. If they ever drift (e.g. someone edits the bundled
  // copy), the build is broken.
  const onDisk = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  assert.deepEqual(onDisk.addOns, [...ADDONS],
    "templates/add-ons.json and the extension-bundled catalog have drifted");
});

// ── getAddOn ────────────────────────────────────────────────────────

test("getAddOn returns the entry for a known key", () => {
  // Picks the first entry to avoid coupling to a specific name.
  const first = ADDONS[0];
  const found = getAddOn(first.key);
  assert.deepEqual(found, first);
});

test("getAddOn returns undefined for an unknown key", () => {
  assert.equal(getAddOn("definitely-not-a-real-addon"), undefined);
});

// ── formatAddonsBlock ───────────────────────────────────────────────

test("formatAddonsBlock includes the on/off marker per entry", () => {
  // Pick the first two real keys so this test stays decoupled from the
  // specific catalog contents.
  const onKey = ADDONS[0].key;
  const offKey = ADDONS[1]?.key;
  const enabled = { [onKey]: true };
  const out = formatAddonsBlock(enabled);
  assert.match(out, /Available add-ons.*toggle by asking the agent/);
  assert.match(out, new RegExp(`- ${onKey} \\[ON\\]:`));
  if (offKey) {
    assert.match(out, new RegExp(`- ${offKey} \\[off\\]:`));
  }
});

test("formatAddonsBlock with null enabled marks every entry off", () => {
  const out = formatAddonsBlock(null);
  for (const a of ADDONS) {
    assert.match(out, new RegExp(`- ${a.key} \\[off\\]:`),
      `expected ${a.key} to be marked off when enabled is null`);
  }
});

test("formatAddonsBlock warns against hand-editing in the header", () => {
  const out = formatAddonsBlock({});
  // The header must tell the agent (and a curious model) NOT to invent
  // hand-edit instructions for the user.
  assert.match(out, /never hand-edit features\.json/i);
});

test("formatAddonsBlock has no copy-paste snippets (VISION rule)", () => {
  // Same forbidden patterns as the catalog - the system-prompt block
  // is what the model sees, so it must not feed a "set foo: true"
  // suggestion the model might then echo at the user.
  const out = formatAddonsBlock({});
  assert.ok(!/\bset\s+["'`]?\w+["'`]?\s*[:=]\s*true\b/i.test(out),
    "system-prompt block must not contain 'set X: true' snippets");
  assert.ok(!/^\s*"\w+"\s*:\s*true/m.test(out),
    "system-prompt block must not contain raw JSON true lines");
});
