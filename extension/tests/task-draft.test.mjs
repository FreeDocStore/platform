// Tests for loadTaskDraft (adapters/source-fetch.ts): a follow-up turn on an
// edit thread must be able to find the task's UNAPPLIED draft proposal so it
// revises that draft instead of the committed repo file (which, for a brand-new
// page, doesn't exist yet — the "doesn't exist yet, nothing to edit" bug).

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

function installChromeMock() {
  const store = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        get: async (key) => {
          if (key == null) return Object.fromEntries(store);
          const k = typeof key === "string" ? key : Array.isArray(key) ? key[0] : Object.keys(key)[0];
          const v = store.get(k);
          return v === undefined ? {} : { [k]: v };
        },
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
        },
      },
    },
  };
  return store;
}

installChromeMock();

const { upsertTask } = await import(await bundle("src/lib/tasks.ts"));
const { savePendingProposal } = await import(await bundle("src/lib/proposals.ts"));
const { loadTaskDraft } = await import(await bundle("src/adapters/source-fetch.ts"));

function mkTask(over = {}) {
  return {
    id: "t1",
    title: "Add team page",
    status: "proposed",
    repo: "acme/docs",
    sourcePath: "docs/team.md",
    summary: "Add team page",
    conversation: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

test("loadTaskDraft: returns the task's live create draft (null sha preserved)", async () => {
  const proposalId = await savePendingProposal({
    kind: "edit",
    taskId: "t1",
    owner: "acme",
    repo: "docs",
    path: "docs/team.md",
    summary: "Add team page",
    outcomes: [{ find: "", replace: "# Team\n", applied: true }],
    editedContent: "# Team\n",
    fileSha: null, // a brand-new page: no committed file yet
    commitMode: "pr",
  });
  await upsertTask(mkTask({ proposalId }));

  const draft = await loadTaskDraft("t1");
  assert.ok(draft);
  assert.equal(draft.kind, "edit");
  assert.equal(draft.path, "docs/team.md");
  assert.equal(draft.editedContent, "# Team\n");
  assert.equal(draft.fileSha, null);
});

test("loadTaskDraft: undefined taskId -> null", async () => {
  assert.equal(await loadTaskDraft(undefined), null);
});

test("loadTaskDraft: task without a proposalId -> null", async () => {
  await upsertTask(mkTask({ id: "t2", proposalId: undefined }));
  assert.equal(await loadTaskDraft("t2"), null);
});

test("loadTaskDraft: dangling proposalId (already applied/cancelled) -> null", async () => {
  await upsertTask(mkTask({ id: "t3", proposalId: "gone-forever" }));
  assert.equal(await loadTaskDraft("t3"), null);
});
