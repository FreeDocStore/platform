import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { attachDraft, beginEditFromReply, completeDraftSend, getAttachedDraft, removeAttachedDraft } = await import(await bundle("src/sidepanel/draft-attachment.ts"));

test("drafts stay isolated by scope and edit thread, including older reply text", () => {
  const original = "# Complete draft\n\nA detailed body that must remain intact.";
  attachDraft("scope-a", "edit-a", original);
  attachDraft("scope-a", "edit-b", "other thread");
  assert.equal(getAttachedDraft("scope-a", { kind: "edit", taskId: "edit-a" }), original);
  assert.equal(getAttachedDraft("scope-a", { kind: "edit", taskId: "edit-b" }), "other thread");
  assert.equal(getAttachedDraft("scope-b", { kind: "edit", taskId: "edit-a" }), null);
  assert.equal(getAttachedDraft("scope-a", { kind: "ask" }), null);
});

test("starting an edit from an older Ask reply attaches the complete reply and refreshes the chip", () => {
  const original = "# Older answer\n\nComplete body and details.";
  let thread = { kind: "ask" };
  let starts = 0;
  let rendered = 0;
  beginEditFromReply("scope-from-reply", original, () => { starts++; thread = { kind: "edit", taskId: "new-edit" }; }, () => thread, () => { rendered++; });
  assert.equal(starts, 1);
  assert.equal(rendered, 1);
  assert.equal(getAttachedDraft("scope-from-reply", thread), original);
});

test("failed send retains draft; successful send and explicit removal clear it", () => {
  attachDraft("scope-c", "edit-c", "draft to retain");
  const thread = { kind: "edit", taskId: "edit-c" };
  assert.equal(getAttachedDraft("scope-c", thread), "draft to retain");
  completeDraftSend("scope-c", thread, false);
  assert.equal(getAttachedDraft("scope-c", thread), "draft to retain");
  completeDraftSend("scope-c", thread, true);
  assert.equal(getAttachedDraft("scope-c", thread), null);
  attachDraft("scope-c", "edit-c", "explicitly removable");
  removeAttachedDraft("scope-c", thread);
  assert.equal(getAttachedDraft("scope-c", thread), null);
});
