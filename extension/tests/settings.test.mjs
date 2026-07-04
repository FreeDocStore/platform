// Settings merge tests. These exist because a prior shallow spread was
// wiping sibling fields within nested adapter blocks - saving just the
// Claude API key would nuke the model and GitHub token.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { mergeSettings, hydrate } = await import(await bundle("src/settings.ts"));

test("mergeSettings: top-level scalar replaces", () => {
  const out = mergeSettings({ adapter: "claude" }, { adapter: "openai" });
  assert.equal(out.adapter, "openai");
});

test("mergeSettings: nested adapter block is deep-merged, not replaced", () => {
  const current = {
    adapter: "claude",
    claude: { apiKey: "k1", model: "claude-sonnet", githubToken: "g1" },
  };
  const out = mergeSettings(current, { claude: { apiKey: "k2" } });
  // The prior bug returned { claude: { apiKey: "k2" } } and lost model + token.
  assert.deepEqual(out.claude, {
    apiKey: "k2",
    model: "claude-sonnet",
    githubToken: "g1",
  });
});

test("mergeSettings: missing nested block is added cleanly", () => {
  const current = { adapter: "claude" };
  const out = mergeSettings(current, {
    openai: { apiKey: "k", model: "gpt-5.4" },
  });
  assert.equal(out.openai?.apiKey, "k");
  assert.equal(out.adapter, "claude");
});

test("mergeSettings: undefined patch values don't wipe existing", () => {
  const current = {
    adapter: "claude",
    claude: { apiKey: "k1", model: "m1", githubToken: "g1" },
  };
  const out = mergeSettings(current, { claude: undefined });
  assert.deepEqual(out.claude, current.claude);
});

test("mergeSettings: sibling adapter blocks are preserved", () => {
  const current = {
    adapter: "claude",
    claude: { apiKey: "k1", model: "m1", githubToken: "g1" },
    openai: { apiKey: "ok", model: "gpt-5.4" },
  };
  const out = mergeSettings(current, { claude: { apiKey: "k2" } });
  assert.equal(out.openai?.apiKey, "ok");
  assert.equal(out.claude?.apiKey, "k2");
});

test("mergeSettings: arrays are replaced, not concatenated", () => {
  // Not strictly needed today since Settings has no arrays, but documents
  // behavior for future adapters.
  const current = { adapter: "claude", __arr: [1, 2, 3] };
  const out = mergeSettings(current, { __arr: [9] });
  assert.deepEqual(out.__arr, [9]);
});

test("hydrate: applies defaults when storage is empty", () => {
  const s = hydrate(null);
  assert.equal(s.adapter, "claude");
});

test("hydrate: user-supplied adapter wins over default", () => {
  const s = hydrate({ adapter: "openai" });
  assert.equal(s.adapter, "openai");
});

// ── persistence resilience (sync <-> local fallback) ──────────────────
// These import the storage wrappers with a configurable chrome mock, so we can
// prove a save survives sync being full/disabled - the "font size didn't save"
// class of bug.
const { loadStoredSettings, patchStoredSettings, SETTINGS_KEY } =
  await import(await bundle("src/settings.ts"));

function installStorageMock({ syncFails = false, syncWriteFails = false } = {}) {
  const sync = new Map();
  const local = new Map();
  // getFail models a fully-unavailable area (disabled/signed-out Chrome).
  // setFail alone models the REAL quota case: writes reject but the last
  // stored value stays readable - the scenario that stranded fresh saves.
  const area = (m, getFail, setFail) => ({
    get: async (key) => {
      if (getFail) throw new Error("sync unavailable");
      const v = m.get(key);
      return v === undefined ? {} : { [key]: v };
    },
    set: async (obj) => {
      if (getFail || setFail) throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
      for (const [k, v] of Object.entries(obj)) m.set(k, v);
    },
    remove: async (key) => { m.delete(key); },
  });
  globalThis.chrome = {
    storage: {
      sync: area(sync, syncFails, syncWriteFails),
      local: area(local, false, false),
    },
  };
  return { sync, local };
}

test("patch+load round-trips fontSize through sync", async () => {
  installStorageMock();
  await patchStoredSettings({ fontSize: 17 });
  const s = await loadStoredSettings();
  assert.equal(s.fontSize, 17);
});

test("save survives when sync is full/disabled (falls back to local)", async () => {
  const { sync, local } = installStorageMock({ syncFails: true });
  // Save must not throw even though every sync op rejects.
  await patchStoredSettings({ fontSize: 21 });
  assert.equal(sync.has(SETTINGS_KEY), false, "sync write rejected");
  assert.ok(local.has(SETTINGS_KEY), "settings persisted to local instead");
  // And loading falls back to local, so the value is NOT lost after 'refresh'.
  const s = await loadStoredSettings();
  assert.equal(s.fontSize, 21);
});

test("patch merges onto the local-fallback copy when sync is down", async () => {
  installStorageMock({ syncFails: true });
  await patchStoredSettings({ fontSize: 15 });
  await patchStoredSettings({ theme: "light" }); // must not wipe fontSize
  const s = await loadStoredSettings();
  assert.equal(s.fontSize, 15);
  assert.equal(s.theme, "light");
});

test("fresh save wins when sync WRITE fails but its stale value is still readable", async () => {
  // The real 8KB-quota bug: sync holds an old value, sync.set() rejects, so the
  // new value lands only in local. A sync-first read returned the STALE sync
  // copy forever ("won't save"); the fresher-stamp read must return the local one.
  const { sync, local } = installStorageMock();
  await patchStoredSettings({ fontSize: 13 }); // succeeds to both stores
  assert.ok(sync.has(SETTINGS_KEY) && local.has(SETTINGS_KEY));

  // Now sync writes start rejecting (over quota) while its old value stays readable.
  installFailingSyncWrites();
  await patchStoredSettings({ fontSize: 99 }); // only local accepts the write

  const s = await loadStoredSettings();
  assert.equal(s.fontSize, 99, "read must prefer the fresher local copy, not stale sync");
});

// Helper: flip the already-installed mock so sync GET still works (returns the
// last value) but sync SET rejects - keeping the same backing Maps.
function installFailingSyncWrites() {
  const g = globalThis.chrome.storage;
  const origSet = g.sync.set;
  g.sync.set = async () => { throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded"); };
  void origSet;
}

// autoContinue is the small in-thread loop toggle (default on). The opt-out
// must survive a settings merge; a shallow spread bug would drop it and
// silently re-enable auto-driving after the user turned it off.
test("mergeSettings: autoContinue=false opt-out persists through a merge", () => {
  const out = mergeSettings(
    { adapter: "claude", autoContinue: false, claude: { apiKey: "k" } },
    { claude: { apiKey: "k2" } },
  );
  assert.equal(out.autoContinue, false, "opting out of the loop must not be wiped by an unrelated patch");
});

test("DEFAULT_SETTINGS: autoContinue defaults ON", async () => {
  const { DEFAULT_SETTINGS } = await import(await bundle("src/types.ts"));
  assert.equal(DEFAULT_SETTINGS.autoContinue, true);
});
