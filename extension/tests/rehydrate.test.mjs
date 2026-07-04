// Tests for the preview re-hydration core (src/sidepanel/rehydrate.ts) - the
// fix that lets a proposal survive a tab switch so you can still Apply it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { expiredPreviewTargets, applyRehydration, rehydratePreviews } =
  await import(await bundle("src/sidepanel/rehydrate.ts"));

const expiredRow = (proposalId) => ({
  role: "assistant",
  content: "Proposed change",
  attachment: { kind: "preview_resolved", data: { proposalId, outcome: "expired" } },
});
const liveProposal = (proposalId) => ({ proposalId, kind: "edit", path: "docs/x.md" });

test("expiredPreviewTargets: picks only expired-preview rows with a proposalId", () => {
  const msgs = [
    { role: "user", content: "hi" },
    expiredRow("p1"),
    { role: "assistant", content: "done", attachment: { kind: "commit", data: { url: "u" } } },
    { role: "assistant", content: "resolved-ok", attachment: { kind: "preview_resolved", data: { proposalId: "p9", outcome: "applied" } } },
    expiredRow("p2"),
    { role: "assistant", content: "no id", attachment: { kind: "preview_resolved", data: { outcome: "expired" } } },
  ];
  assert.deepEqual(expiredPreviewTargets(msgs), [
    { index: 1, proposalId: "p1" },
    { index: 4, proposalId: "p2" },
  ]);
});

test("expiredPreviewTargets: empty when nothing matches", () => {
  assert.deepEqual(expiredPreviewTargets([{ role: "user", content: "x" }]), []);
});

test("applyRehydration: restores live proposals, leaves gone ones expired", () => {
  const msgs = [expiredRow("p1"), { role: "user", content: "mid" }, expiredRow("p2")];
  const targets = expiredPreviewTargets(msgs);
  const { messages, restored } = applyRehydration(msgs, targets, [liveProposal("p1"), null]);
  assert.equal(restored, 1);
  // p1 restored to a live preview...
  assert.deepEqual(messages[0].attachment, { kind: "preview", data: liveProposal("p1") });
  // ...p2 still a tombstone, unrelated row untouched.
  assert.equal(messages[2].attachment.kind, "preview_resolved");
  assert.equal(messages[1].content, "mid");
  // Original array not mutated (pure).
  assert.equal(msgs[0].attachment.kind, "preview_resolved");
});

test("applyRehydration: no targets -> same reference, restored 0", () => {
  const msgs = [{ role: "user", content: "x" }];
  const out = applyRehydration(msgs, [], []);
  assert.equal(out.messages, msgs);
  assert.equal(out.restored, 0);
});

test("applyRehydration: all gone -> same reference (no needless re-render)", () => {
  const msgs = [expiredRow("p1")];
  const out = applyRehydration(msgs, expiredPreviewTargets(msgs), [null]);
  assert.equal(out.messages, msgs);
  assert.equal(out.restored, 0);
});

test("rehydratePreviews: loads via callback and restores the survivors", async () => {
  const store = new Map([["p1", liveProposal("p1")]]); // p2 absent (expired for real)
  const msgs = [expiredRow("p1"), expiredRow("p2")];
  const { messages, restored } = await rehydratePreviews(msgs, async (id) => store.get(id) ?? null);
  assert.equal(restored, 1);
  assert.equal(messages[0].attachment.kind, "preview");
  assert.equal(messages[1].attachment.kind, "preview_resolved");
});

test("rehydratePreviews: a loader that throws is treated as gone, not fatal", async () => {
  const msgs = [expiredRow("p1")];
  const { restored } = await rehydratePreviews(msgs, async () => { throw new Error("session read failed"); });
  assert.equal(restored, 0);
});
