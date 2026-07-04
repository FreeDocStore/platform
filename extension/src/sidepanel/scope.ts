// Scope + context: resolving which repo/page the panel is pointed at, swapping
// the in-memory transcript to that scope's bucket, restoring live proposals, and
// reflecting write-access into the UI. Each repo/origin has its own conversation;
// this module is the hook that switches conversations on tab navigation.
//
// Extracted from sidepanel.ts. Imports thread-ui + message-view downward; the
// core imports refreshContext (run once at boot) + initScope (tab listeners).

import type { PageContext } from "../types";
import { state, history, scrollByScope } from "./state";
import { messagesEl, contextEl, threadSelectEl, accessBadgeEl, chatAreaEl, noRepoStateEl, formEl, threadNavEl } from "./dom-refs";
import { appendMessage } from "./message-view";
import {
  closeThreadMenu,
  renderActiveThread,
  renderEditsList,
  renderThreadHeader,
  selectAsk,
  showChatView,
} from "./thread-ui";
import { dlog, stashLog, restoreLog } from "./debug-bridge";
import { applyRehydration, expiredPreviewTargets } from "./rehydrate";
import { loadPendingProposal } from "../lib/proposals";
import { renderFeaturesTag } from "./format";
import { getActiveTabContext } from "./tab-messaging";
import { sendToBg } from "../lib/messaging";
import {
  isStaleReply,
  readScopeHistory,
  scopeFromContext,
  type Scope,
} from "../lib/history";

// Restore live Apply/Cancel previews for any expired-marker rows whose
// underlying proposal is still in chrome.storage.session. Loads all candidates
// first (via the pure rehydrate core), then writes back only if this load is
// still the winner (loadId guard) so a concurrent scope swap can't get its
// history clobbered. Mutates `history` in place to preserve its identity.
async function rehydrateProposals(loadId: number): Promise<void> {
  const targets = expiredPreviewTargets(history);
  if (!targets.length) return;
  const loaded = await Promise.all(
    targets.map((t) => loadPendingProposal(t.proposalId).catch(() => null)),
  );
  if (loadId !== state.activeLoadId) return;
  const { messages, restored } = applyRehydration(history, targets, loaded);
  if (!restored) return;
  history.length = 0;
  history.push(...messages);
}

/**
 * Swap the in-memory history + diagnostic log to the given scope. Re-renders the
 * chat with the new scope's messages. No-op when the scope hasn't changed.
 */
async function loadScope(scope: Scope): Promise<void> {
  if (scope === state.currentScope && history.length > 0) return;
  // Did the repo/page actually change? refreshContext calls loadScope on every
  // tabs.onUpdated(status:complete) too, so navigating between pages of the
  // SAME repo re-enters here with an unchanged scope. In that case we must not
  // snap the thread back to Ask - that would silently kill a fresh "New edit"
  // thread (empty transcript, so the early-return above doesn't catch it) and
  // downgrade the user's next message to a read-only Ask turn.
  const scopeChanged = scope !== state.currentScope;
  const loadId = ++state.activeLoadId;
  // Stash the current scope's diag log AND scroll position before
  // swapping in the new one.
  stashLog(state.currentScope);
  scrollByScope.set(state.currentScope, messagesEl.scrollTop);

  state.currentScope = scope;
  const arr = await readScopeHistory(scope);
  if (loadId !== state.activeLoadId) return;

  history.length = 0;
  history.push(...arr);

  // Re-hydrate still-live proposals. Persisted history stores previews slimmed
  // to preview_resolved/expired so local storage doesn't balloon - but the real
  // PendingProposal lives in chrome.storage.session, which survives SW restarts
  // AND tab switches within the same browser session. If it's still there,
  // restore the LIVE preview (Apply/Cancel) instead of the "expired" tombstone.
  // Without this, switching tabs (or navigating the docs page) between proposing
  // and applying wrongly showed "expired" and you could never push the change.
  await rehydrateProposals(loadId);
  if (loadId !== state.activeLoadId) return;

  restoreLog(scope);

  // A scope swap means a different repo/page: threads are per-repo, so snap
  // back to Ask for the new repo. A same-scope reload preserves the active
  // thread (see scopeChanged note above). Also drop out of "compose new
  // request" mode - a start card belongs to the page it was opened on, so
  // switching repos must not carry it (and its new-edit taskId) to another one.
  if (scopeChanged) {
    state.activeThread = { kind: "ask" };
    state.composing = false;
  }
  closeThreadMenu();
  // Keep the in-panel list in sync with the new repo; on a scope change fall
  // back to chat so we don't show another repo's edits.
  if (state.panelView === "list") {
    if (scopeChanged) showChatView();
    else void renderEditsList();
  }
  renderActiveThread();

  // Restore scroll position for the new scope, overriding the
  // auto-scroll-to-bottom renderActiveThread applied. Browsers clamp
  // scrollTop to the scrollable range, so a stale saved position is
  // harmless; default (none) is bottom.
  const savedScroll = scrollByScope.get(scope);
  if (savedScroll !== undefined) {
    messagesEl.scrollTop = savedScroll;
  }
}

function renderContext(ctx: PageContext | null): void {
  // Stash for the start card + the message-view link handler (same-site vs new
  // tab). Kept current by refreshContext on every tab change.
  state.currentContext = ctx;
  // If the start card is up (composing) it was painted from the PREVIOUS
  // context - loadScope renders it before this runs, and a same-scope soft
  // navigation doesn't re-render it at all. Repaint it now against the fresh
  // context so it never shows a stale page/repo.
  if (state.composing) void renderThreadHeader();
  // A page with no linked GitHub repo (no source-repo meta tag) has nothing to
  // chat about or edit: hide the chat + composer and show the empty state. This
  // covers both "not a docs site" and "a docs site that never embedded the tag".
  const hasRepo = !!ctx?.repo;
  noRepoStateEl.hidden = hasRepo;
  chatAreaEl.hidden = !hasRepo;
  formEl.hidden = !hasRepo;
  threadNavEl.hidden = !hasRepo; // Ask/edits controls do nothing without a repo

  // No repo → no access state to show (reflectPermissions only runs when a repo
  // is known, so clear a stale badge from the previous page here). The empty
  // state carries the explanation, so keep the context bar terse and skip the
  // misleading guessed sourcePath line.
  if (!ctx || !ctx.repo) {
    accessBadgeEl.hidden = true;
    accessBadgeEl.textContent = "";
    contextEl.textContent = ctx
      ? "(no linked repo)"
      : "(no page context - open a *.pages.dev site)";
    return;
  }
  const repo = `${ctx.repo.owner}/${ctx.repo.name}`;
  const nav = ctx.navConfig ? ` · nav: ${ctx.navConfig.items.length}` : "";
  const features = renderFeaturesTag(ctx.features);
  contextEl.textContent = `${repo} · ${ctx.sourcePath}${nav}${features}`;
}

/**
 * Disable the Edit <option> when we know the user has no write access. If they're
 * already in Edit mode when access is revoked, force them to Read and surface a
 * chat note explaining what happened. UI-only - the adapter still independently
 * checks at chat time.
 */
function reflectPermissions(repoLabel: string | null): void {
  // Write access gates edit threads. If the user lacks it and is sitting on
  // an edit thread, bounce them back to the read-only Ask thread with a note.
  if (state.canEditCurrentRepo === false && state.activeThread.kind === "edit") {
    selectAsk();
    void appendMessage({
      role: "assistant",
      content: repoLabel
        ? `Switched to Ask - you have read-only access to ${repoLabel}. To edit, sign in with an account that has write access to that repo.`
        : "Switched to Ask - you don't have write access to this repo.",
    });
  }
  threadSelectEl.title =
    state.canEditCurrentRepo === false
      ? repoLabel
        ? `Read-only access to ${repoLabel}; editing is disabled.`
        : "Read-only access to this repo; editing is disabled."
      : "Switch thread (Ask / edits)";
  // Visible, explicit access state: access here is driven by GitHub repo
  // permissions (the token can only read/write what the user's GitHub account
  // can). Surface "read-only" plainly rather than only via a tooltip. null =
  // unknown (not signed in / no repo) — stay quiet there.
  if (state.canEditCurrentRepo === false) {
    accessBadgeEl.textContent = "🔒 read-only";
    accessBadgeEl.title = repoLabel
      ? `You have read-only access to ${repoLabel} on GitHub — Ask works, editing is disabled. Sign in with an account that has write access to edit.`
      : "You have read-only access to this repo on GitHub — editing is disabled.";
    accessBadgeEl.hidden = false;
  } else {
    accessBadgeEl.hidden = true;
    accessBadgeEl.textContent = "";
  }
}

export async function refreshContext(): Promise<void> {
  const refreshId = ++state.activeRefreshId;
  const ctx = await getActiveTabContext();
  // If the user navigated to another tab (or page) while we were
  // resolving context, drop this result - a newer refreshContext is
  // already in flight and will write the correct state.
  if (refreshId !== state.activeRefreshId) return;

  // Switch the chat (and the diagnostic log) to the new site/repo's
  // bucket. Each repo/origin has its own conversation; this is the
  // hook that makes that switch happen on tab navigation.
  await loadScope(scopeFromContext(ctx));
  if (refreshId !== state.activeRefreshId) return;

  renderContext(ctx);

  // If the page has a known repo, check write access in the background
  // and update the mode dropdown's Edit availability. Stays permissive
  // (state.canEditCurrentRepo = null) when there's no repo or the user isn't
  // signed in - the adapter's existing configError catches those cases
  // at chat time.
  if (ctx?.repo) {
    const repoLabel = `${ctx.repo.owner}/${ctx.repo.name}`;
    // Snapshot scope so the permission-change banner that
    // reflectPermissions may emit via appendMessage doesn't end up in
    // the WRONG site's chat if the user tab-switched during the
    // CHECK_PERMISSIONS round-trip. The refreshId guard isn't enough
    // because a race can land us in a state where refreshId is current
    // but state.currentScope has already been swapped by another loadScope.
    const permsScope = state.currentScope;
    try {
      const resp = (await sendToBg({
        type: "CHECK_PERMISSIONS",
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
      })) as { type: string; payload: { push: boolean } | null };
      // Late-arriving permissions for a repo the user has since
      // navigated away from would otherwise toggle Edit on/off
      // incorrectly. Drop the result if a newer refresh is in flight.
      if (refreshId !== state.activeRefreshId) {
        dlog("permissions reply dropped (newer refresh in flight)", { repo: repoLabel, refreshId });
        return;
      }
      if (isStaleReply(permsScope, state.currentScope)) {
        dlog("permissions reply dropped (tab scope changed)", { permsScope, scope: state.currentScope });
        return;
      }
      if (resp.payload === null) {
        state.canEditCurrentRepo = null;
      } else {
        state.canEditCurrentRepo = resp.payload.push;
      }
      dlog("permissions checked", { repo: repoLabel, canEdit: state.canEditCurrentRepo });
      reflectPermissions(repoLabel);
    } catch {
      if (refreshId !== state.activeRefreshId) return;
      if (isStaleReply(permsScope, state.currentScope)) return;
      state.canEditCurrentRepo = null;
      reflectPermissions(repoLabel);
    }
  } else {
    state.canEditCurrentRepo = null;
    reflectPermissions(null);
  }
}

/** Wire the tab-change / page-load listeners that keep the context line fresh. */
export function initScope(): void {
  // Update the context line whenever the active tab changes or the page in the
  // active tab finishes loading or changes URL. Without this the line stays
  // frozen on the first URL the panel was opened against.
  chrome.tabs.onActivated.addListener(() => {
    void refreshContext();
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    // Only care about URL changes and full-page loads. `status === "complete"`
    // covers the soft-nav case where a new docs page is rendered (the content
    // script gets re-injected and nav.json may have changed).
    if (changeInfo.url == null && changeInfo.status !== "complete") return;
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id !== tabId) return;
    void refreshContext();
  });
}
