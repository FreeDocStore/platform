// Pure core of the "restore a live preview" logic (see loadScope).
//
// Persisted chat history stores previews slimmed to a preview_resolved/expired
// tombstone so local storage doesn't balloon. But the real PendingProposal
// lives in chrome.storage.session, which survives service-worker restarts AND
// tab switches within the same browser session. When we reload history we ask
// the session store whether each expired row's proposal is still alive; if so we
// swap the tombstone back to a live { kind: "preview" } attachment so Apply/
// Cancel work again. Without this, switching tabs between proposing and applying
// wrongly showed "expired" and the change could never be pushed.
//
// This module is pure (no chrome/DOM/module state) so it's unit-testable; the
// panel wraps it with a concurrency (loadId) guard.

import type { ChatMessage, PendingProposal } from "../types";

/** An expired-preview row that carries a proposalId we can try to restore. */
export interface RehydrateTarget {
  index: number;
  proposalId: string;
}

/** Collect the history rows that are expired-preview tombstones. */
export function expiredPreviewTargets(messages: ChatMessage[]): RehydrateTarget[] {
  const targets: RehydrateTarget[] = [];
  messages.forEach((m, index) => {
    const att = m.attachment;
    if (att?.kind !== "preview_resolved") return;
    const data = att.data as { proposalId?: string; outcome?: string } | undefined;
    if (data?.outcome === "expired" && data.proposalId) {
      targets.push({ index, proposalId: data.proposalId });
    }
  });
  return targets;
}

/**
 * Given the original messages and the proposals loaded for their expired rows
 * (aligned to expiredPreviewTargets order), return a NEW message list with the
 * still-alive proposals restored to live previews. Rows whose proposal is gone
 * (null) keep their expired tombstone. Returns the same array reference and
 * restored:0 when there's nothing to do, so callers can skip a re-render.
 */
export function applyRehydration(
  messages: ChatMessage[],
  targets: RehydrateTarget[],
  loaded: Array<PendingProposal | null>,
): { messages: ChatMessage[]; restored: number } {
  if (!targets.length) return { messages, restored: 0 };
  const next = [...messages];
  let restored = 0;
  targets.forEach((t, k) => {
    const proposal = loaded[k];
    if (proposal) {
      next[t.index] = { ...next[t.index], attachment: { kind: "preview", data: proposal } };
      restored++;
    }
  });
  return { messages: restored ? next : messages, restored };
}

/**
 * Convenience wrapper: collect targets, load each proposal via `load`, and
 * apply the restoration. `load` failures are treated as "gone". The panel
 * doesn't use this directly (it needs a loadId guard around the await), but
 * tests and any non-concurrent caller can.
 */
export async function rehydratePreviews(
  messages: ChatMessage[],
  load: (proposalId: string) => Promise<PendingProposal | null>,
): Promise<{ messages: ChatMessage[]; restored: number }> {
  const targets = expiredPreviewTargets(messages);
  if (!targets.length) return { messages, restored: 0 };
  const loaded = await Promise.all(
    targets.map((t) => load(t.proposalId).catch(() => null)),
  );
  return applyRehydration(messages, targets, loaded);
}
