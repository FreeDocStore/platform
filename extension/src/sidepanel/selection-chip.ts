// The selection chip: reflects what the user highlighted on the page (via the
// in-page "Edit this" button) so they can see the exact change target before
// sending. The selection itself rides to the agent inside PageContext.selection;
// this is just the UI mirror + the clear control. The content-script RPC helpers
// (querySelectionFromTab / clearSelectionInTab) live in ./tab-messaging.
//
// Extracted from sidepanel.ts. Reads state.activeThread + the chip DOM refs;
// wiring (clear button, visibility poll, SELECTION_RESULT broadcast) is set up
// by initSelectionChip() so nothing runs at import time.

import { state } from "./state";
import { selChipEl, selChipTextEl, selIndicatorEl, selChipClearBtn } from "./dom-refs";
import { querySelectionFromTab, clearSelectionInTab } from "./tab-messaging";

export function renderSelectionChip(sel: { text: string; heading?: string } | null): void {
  if (!sel || !sel.text.trim()) {
    selChipEl.hidden = true;
    selChipTextEl.textContent = "";
    // No selection. In an edit thread the whole open page is the context, so
    // say that instead of showing nothing - the user shouldn't wonder what
    // an unselected edit will act on.
    if (state.activeThread.kind === "edit") {
      selIndicatorEl.textContent = "· 📄 whole page as context";
      selIndicatorEl.title =
        "No text selected — the whole open page is used as context. Select text on the page to target a specific part.";
      selIndicatorEl.hidden = false;
    } else {
      selIndicatorEl.hidden = true;
      selIndicatorEl.textContent = "";
    }
    return;
  }
  const shown = sel.text.length > 120 ? sel.text.slice(0, 117) + "…" : sel.text;
  selChipTextEl.textContent = `Selected: "${shown}"`;
  selChipTextEl.title = sel.heading ? `Under "${sel.heading}"\n\n${sel.text}` : sel.text;
  selChipEl.hidden = false;
  // Mirror into the always-visible context bar so the attached selection is
  // never a mystery, even after the chip is cleared on send.
  const brief = sel.text.length > 60 ? sel.text.slice(0, 57) + "…" : sel.text;
  selIndicatorEl.textContent = `· ✎ selected: "${brief}"`;
  selIndicatorEl.title = sel.text;
  selIndicatorEl.hidden = false;
}

export async function refreshSelectionChip(): Promise<void> {
  renderSelectionChip(await querySelectionFromTab());
}

/** Wire the clear button and the visibility poll.
 *
 * The SELECTION_RESULT broadcast (fired when the in-page "Edit this" button
 * pins a selection) is handled in thread-ui, not here: "Edit this" opens the
 * unified new-edit start card with the selection attached, so the chip render
 * and the compose-open have to happen together in one place. This module just
 * renders the chip when asked and keeps it fresh via the poll. */
export function initSelectionChip(): void {
  selChipClearBtn.addEventListener("click", () => {
    void clearSelectionInTab();
    renderSelectionChip(null);
  });

  // Poll only while the panel is visible - no point messaging the tab when
  // the user can't see the chip.
  setInterval(() => {
    if (document.visibilityState === "visible") void refreshSelectionChip();
  }, 1000);
}
