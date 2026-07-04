// Shared task presentation helpers (lib/task-format), used by the board, the
// side panel, and the in-panel kanban. Consolidated from two prior copies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { statusLabelFor, statusColor, ageLabel } =
  await import(await bundle("src/lib/task-format.ts"));

test("statusLabelFor: human labels for every status incl. cancelled", () => {
  assert.equal(statusLabelFor("proposed"), "Proposed");
  assert.equal(statusLabelFor("in_review"), "In review");
  assert.equal(statusLabelFor("deployed"), "Deployed");
  assert.equal(statusLabelFor("done"), "Done");
  assert.equal(statusLabelFor("cancelled"), "Cancelled");
});

test("statusColor: accent once headed live, muted otherwise", () => {
  for (const s of ["in_review", "deployed", "done"]) {
    assert.equal(statusColor(s), "var(--accent)");
  }
  for (const s of ["proposed", "cancelled"]) {
    assert.equal(statusColor(s), "var(--text-muted)");
  }
});

test("ageLabel: buckets seconds/minutes/hours/days (now is injectable)", () => {
  const now = 1_000_000_000_000;
  assert.equal(ageLabel(now, now), "just now");
  assert.equal(ageLabel(now - 30_000, now), "just now");
  assert.equal(ageLabel(now - 5 * 60_000, now), "5m ago");
  assert.equal(ageLabel(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(ageLabel(now - 2 * 86_400_000, now), "2d ago");
  // future timestamp clamps to "just now" rather than a negative age.
  assert.equal(ageLabel(now + 60_000, now), "just now");
});
