// Pending-proposal store: save -> load round-trip strips the internal _savedAt,
// the prune cap bounds retained proposals to the newest N, and a corrupted /
// legacy-shaped blob loads as null (an "expired preview") rather than reaching
// the commit path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

// chrome.storage.local mock. get(null) lists all (prune relies on it).
function installChromeMock() {
  const m = new Map();
  const area = {
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    get: async (key) => {
      if (key == null) return Object.fromEntries(m);
      const k = typeof key === "string" ? key : Array.isArray(key) ? key[0] : Object.keys(key)[0];
      const v = m.get(k);
      return v === undefined ? {} : { [k]: v };
    },
    remove: async (key) => {
      for (const k of Array.isArray(key) ? key : [key]) m.delete(k);
    },
  };
  globalThis.chrome = { storage: { local: area } };
  return m;
}
const store = installChromeMock();

const { savePendingProposal, loadPendingProposal, removePendingProposal } =
  await import(await bundle("src/lib/proposals.ts"));

const draft = (over = {}) => ({
  kind: "edit",
  owner: "o",
  repo: "r",
  path: "docs/x.md",
  summary: "s",
  outcomes: [],
  editedContent: "hello",
  fileSha: "sha",
  commitMode: "direct",
  ...over,
});

test("save -> load round-trips the proposal and strips _savedAt", async () => {
  const id = await savePendingProposal(draft());
  const loaded = await loadPendingProposal(id);
  assert.equal(loaded.proposalId, id);
  assert.equal(loaded.kind, "edit");
  assert.equal(loaded.editedContent, "hello");
  assert.equal("_savedAt" in loaded, false, "internal bookkeeping field must not leak to callers");
});

test("remove deletes the proposal (load then returns null)", async () => {
  const id = await savePendingProposal(draft());
  await removePendingProposal(id);
  assert.equal(await loadPendingProposal(id), null);
});

test("load returns null for a malformed/legacy blob (expired preview, not a bad commit)", async () => {
  // Write a corrupted record directly under a proposal: key.
  await chrome.storage.local.set({ "proposal:corrupt": { kind: "bogus", owner: 1 } });
  assert.equal(await loadPendingProposal("corrupt"), null);
  // Missing discriminant entirely.
  await chrome.storage.local.set({ "proposal:nokind": { owner: "o", repo: "r", proposalId: "nokind" } });
  assert.equal(await loadPendingProposal("nokind"), null);
});

test("prune keeps only the newest MAX_PROPOSALS (50) by _savedAt", async () => {
  // Fresh store for a clean count.
  store.clear();
  // Seed 60 with strictly increasing _savedAt so ordering is deterministic
  // (avoids relying on Date.now() resolution between rapid saves).
  for (let i = 0; i < 60; i++) {
    await chrome.storage.local.set({ [`proposal:seed${i}`]: { kind: "edit", owner: "o", repo: "r", proposalId: `seed${i}`, _savedAt: i } });
  }
  // A save triggers prune().
  await savePendingProposal(draft());
  const all = await chrome.storage.local.get(null);
  const remaining = Object.keys(all).filter((k) => k.startsWith("proposal:"));
  assert.equal(remaining.length, 50, "prune caps retained proposals at 50");
  // The oldest seeds (lowest _savedAt) must be gone; the newest must survive.
  assert.equal(remaining.includes("proposal:seed0"), false, "oldest pruned");
  assert.equal(remaining.includes("proposal:seed59"), true, "newest kept");
});
