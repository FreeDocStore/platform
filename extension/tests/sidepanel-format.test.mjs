// Unit tests for the pure side-panel formatting helpers (src/sidepanel/format.ts).
// These are the only side-panel functions that are import-safe in node --test
// (no DOM / chrome / module state), which is exactly why they were extracted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { formatTime, sameUrlIgnoringHash, slimForPersist, renderFeaturesTag, statusColor, statusLabelFor } =
  await import(await bundle("src/sidepanel/format.ts"));

test("formatTime: zero-pads HH:MM in local time", () => {
  // Build a local-time date so the assertion is timezone-independent.
  const d = new Date(2020, 0, 1, 9, 5); // 09:05 local
  assert.equal(formatTime(d.getTime()), "09:05");
  const d2 = new Date(2020, 0, 1, 23, 59);
  assert.equal(formatTime(d2.getTime()), "23:59");
});

test("sameUrlIgnoringHash: matches origin+path+search, ignores #fragment", () => {
  assert.equal(sameUrlIgnoringHash("https://x.dev/a?b=1#one", "https://x.dev/a?b=1#two"), true);
  assert.equal(sameUrlIgnoringHash("https://x.dev/a", "https://x.dev/a#frag"), true);
  // Different path / search / origin -> false.
  assert.equal(sameUrlIgnoringHash("https://x.dev/a", "https://x.dev/b"), false);
  assert.equal(sameUrlIgnoringHash("https://x.dev/a?b=1", "https://x.dev/a?b=2"), false);
  assert.equal(sameUrlIgnoringHash("https://x.dev/a", "https://y.dev/a"), false);
});

test("sameUrlIgnoringHash: missing/invalid inputs -> false (never throws)", () => {
  assert.equal(sameUrlIgnoringHash(undefined, "https://x.dev/a"), false);
  assert.equal(sameUrlIgnoringHash("https://x.dev/a", undefined), false);
  assert.equal(sameUrlIgnoringHash("not-a-url", "also-not"), false);
});

test("slimForPersist: collapses a live preview to preview_resolved/expired", () => {
  const msg = {
    role: "assistant",
    content: "x",
    attachment: { kind: "preview", data: { proposalId: "p1", editedContent: "HUGE", extra: 1 } },
  };
  const slim = slimForPersist(msg);
  assert.deepEqual(slim.attachment, { kind: "preview_resolved", data: { proposalId: "p1", outcome: "expired" } });
  // Original untouched (pure), heavy payload dropped in the copy.
  assert.equal(msg.attachment.data.editedContent, "HUGE");
});

test("slimForPersist: leaves non-preview messages unchanged (same reference)", () => {
  const plain = { role: "user", content: "hi" };
  assert.equal(slimForPersist(plain), plain);
  const resolved = { role: "assistant", content: "done", attachment: { kind: "commit", data: { url: "u" } } };
  assert.equal(slimForPersist(resolved), resolved);
});

test("renderFeaturesTag: compact suffix of enabled features, empty when none", () => {
  assert.equal(renderFeaturesTag({ nav: true, search: true }), " · features: nav,search");
  assert.equal(renderFeaturesTag({ pageMeta: true, references: true }), " · features: meta,refs");
  assert.equal(renderFeaturesTag({}), "");
  assert.equal(renderFeaturesTag(null), "");
});

test("statusColor: accent once headed live, muted otherwise", () => {
  assert.equal(statusColor("in_review"), "var(--accent)");
  assert.equal(statusColor("deployed"), "var(--accent)");
  assert.equal(statusColor("done"), "var(--accent)");
  assert.equal(statusColor("proposed"), "var(--text-muted)");
  assert.equal(statusColor("cancelled"), "var(--text-muted)");
});

test("statusLabelFor: human labels for every status", () => {
  assert.equal(statusLabelFor("proposed"), "Proposed");
  assert.equal(statusLabelFor("in_review"), "In review");
  assert.equal(statusLabelFor("deployed"), "Deployed");
  assert.equal(statusLabelFor("done"), "Done");
  assert.equal(statusLabelFor("cancelled"), "Cancelled");
});
