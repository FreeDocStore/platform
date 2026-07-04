// Tests for the pure thread-model logic extracted from sidepanel.ts:
// thread membership, deriving draft threads from tagged history, and repo
// filtering. No DOM required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { activeTaskId, messageBelongsTo, threadIdsInHistory, threadFallbackLabel, threadsForRepo } =
  await import(await bundle("src/sidepanel/thread-model.ts"));

const ask = { kind: "ask" };
const edit = (id) => ({ kind: "edit", taskId: id });

test("activeTaskId: null for ask, taskId for edit", () => {
  assert.equal(activeTaskId(ask), null);
  assert.equal(activeTaskId(edit("t1")), "t1");
});

test("messageBelongsTo: ask shows only untagged, edit shows only its taskId", () => {
  const untagged = { role: "user", content: "hi" };
  const t1 = { role: "user", content: "a", taskId: "t1" };
  const t2 = { role: "user", content: "b", taskId: "t2" };

  assert.equal(messageBelongsTo(untagged, ask), true);
  assert.equal(messageBelongsTo(t1, ask), false);

  assert.equal(messageBelongsTo(t1, edit("t1")), true);
  assert.equal(messageBelongsTo(t2, edit("t1")), false);
  assert.equal(messageBelongsTo(untagged, edit("t1")), false);
});

test("threadIdsInHistory: distinct taskIds in first-seen order, untagged ignored", () => {
  const history = [
    { role: "user", content: "q1" }, // untagged
    { role: "user", content: "a", taskId: "t2" },
    { role: "assistant", content: "a?", taskId: "t2" },
    { role: "user", content: "b", taskId: "t1" },
    { role: "user", content: "c", taskId: "t2" }, // dup
  ];
  assert.deepEqual(threadIdsInHistory(history), ["t2", "t1"]);
});

test("threadIdsInHistory: empty for all-untagged history", () => {
  assert.deepEqual(threadIdsInHistory([{ role: "user", content: "x" }]), []);
});

test("threadFallbackLabel: first user message, trimmed + collapsed, truncated at 40", () => {
  const history = [
    { role: "assistant", content: "hello", taskId: "t1" }, // not a user msg
    { role: "user", content: "  add   a   column  ", taskId: "t1" },
  ];
  assert.equal(threadFallbackLabel(history, "t1"), "add a column");

  const long = "x".repeat(80);
  const h2 = [{ role: "user", content: long, taskId: "t2" }];
  const label = threadFallbackLabel(h2, "t2");
  assert.equal(label.length, 40); // 39 chars + ellipsis
  assert.ok(label.endsWith("…"));
});

test("threadFallbackLabel: no user message -> Untitled edit", () => {
  assert.equal(threadFallbackLabel([], "t9"), "Untitled edit");
  assert.equal(
    threadFallbackLabel([{ role: "assistant", content: "hi", taskId: "t9" }], "t9"),
    "Untitled edit",
  );
});

test("threadsForRepo: filters to repo, drops cancelled + archived, sorts newest first", () => {
  const tasks = [
    { id: "a", repo: "o/r", status: "proposed", updatedAt: 100 },
    { id: "b", repo: "o/r", status: "cancelled", updatedAt: 200 },
    { id: "c", repo: "o/r", status: "done", updatedAt: 300 },
    { id: "d", repo: "other/repo", status: "proposed", updatedAt: 400 },
    { id: "e", repo: "o/r", status: "proposed", updatedAt: 500, archived: true },
  ];
  const out = threadsForRepo(tasks, "o/r");
  assert.deepEqual(out.map((t) => t.id), ["c", "a"]);
});
