// Pending-proposal store. Holds an edit/nav/create proposal between the
// model emitting it and the user clicking Apply or Cancel in the preview UI.
//
// Stored in chrome.storage.LOCAL (not session) so a proposal survives not just
// service-worker restarts but an extension reload / browser restart too. That
// matters: session storage is wiped on every `chrome://extensions` reload, and
// losing the proposal there stranded users with an "expired" preview and no
// Apply button - so they could never publish the change. loadScope re-hydrates
// the live preview from here (see sidepanel/rehydrate.ts).
//
// Proposals are removed on Apply/Cancel. Abandoned ones are bounded by a
// most-recent-N prune so the store can't grow without limit.

import type {
  PendingEditProposal,
  PendingMemoryProposal,
  PendingNavProposal,
  PendingProposal,
} from "../types";

const KEY_PREFIX = "proposal:";
// Cap on retained proposals. Each holds the full edited file (up to ~25KB), so
// bound the count; the oldest beyond this are pruned on save.
const MAX_PROPOSALS = 50;

function key(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

// Distributive Omit for the discriminated union. A plain
// Omit<PendingProposal, "proposalId"> collapses the union to its
// common keys (loses variant-specific fields like `path` or
// `currentContent`), so we spell out the union by hand here.
type PendingProposalDraft =
  | Omit<PendingEditProposal, "proposalId">
  | Omit<PendingNavProposal, "proposalId">
  | Omit<PendingMemoryProposal, "proposalId">;

// What actually lands in storage: the proposal plus a save timestamp used only
// for pruning. `_savedAt` is stripped before the proposal is handed back.
type StoredProposal = PendingProposal & { _savedAt: number };

/** Generate + persist; returns the new proposal id. */
export async function savePendingProposal(p: PendingProposalDraft): Promise<string> {
  const id = crypto.randomUUID();
  const stored = { ...p, proposalId: id, _savedAt: Date.now() } as StoredProposal;
  await chrome.storage.local.set({ [key(id)]: stored });
  await prune();
  return id;
}

// Minimal runtime shape check before a stored blob is trusted by the Apply /
// commit path. chrome.storage can hold a corrupted or legacy-shaped value (an
// interrupted write, a schema change across versions); without this a bad blob
// would reach applyPendingProposal as if valid. We assert only the invariants
// every variant shares - the discriminant + repo coordinates - not full deep
// validation.
function isValidStored(v: unknown): v is StoredProposal {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    (p.kind === "edit" || p.kind === "nav" || p.kind === "memory") &&
    typeof p.owner === "string" &&
    typeof p.repo === "string" &&
    typeof p.proposalId === "string"
  );
}

export async function loadPendingProposal(id: string): Promise<PendingProposal | null> {
  const got = await chrome.storage.local.get(key(id));
  const stored = got[key(id)] as StoredProposal | undefined;
  // Treat a missing OR malformed blob as "no proposal" so a corrupted record
  // surfaces as an expired preview (re-send to retry) rather than a bad commit.
  if (!isValidStored(stored)) return null;
  // Drop the internal bookkeeping field so callers see a clean PendingProposal.
  const { _savedAt, ...proposal } = stored;
  void _savedAt;
  return proposal as PendingProposal;
}

export async function removePendingProposal(id: string): Promise<void> {
  await chrome.storage.local.remove(key(id));
}

// Keep only the MAX_PROPOSALS most-recently-saved proposals. Cheap and rare
// (runs on save); abandoned proposals age out instead of accumulating forever.
async function prune(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith(KEY_PREFIX))
    .map(([k, v]) => ({ k, savedAt: (v as StoredProposal)?._savedAt ?? 0 }));
  if (entries.length <= MAX_PROPOSALS) return;
  entries.sort((a, b) => b.savedAt - a.savedAt); // newest first
  const toRemove = entries.slice(MAX_PROPOSALS).map((e) => e.k);
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}
