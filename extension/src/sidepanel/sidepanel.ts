// Side panel script: UI for the chat, calls background for settings and
// chat turns, asks the active tab's content script for page context.

import type { ChatMessage, PendingProposal } from "../types";
import { openBoard } from "./board-nav";
import { appendLinkified } from "./linkify";
import {
  wirePopToggle,
  setPopMenuCloseHook,
  initPopMenuDismissal,
} from "./pop-menu";
import { initReverseChannel } from "./reverse-channel";
import { initPanelPresence } from "./panel-presence";
import { disarmClear, initChatActions } from "./chat-actions";
import {
  getActiveTabContext,
  clearSelectionInTab,
  navigateActiveTab,
} from "./tab-messaging";
import {
  initDebug,
  dlog,
} from "./debug-bridge";
import {
  formatTime,
  slimForPersist,
} from "./format";
import { renderMarkdown } from "../lib/markdown";
import { getTask } from "../lib/tasks";
import {
  isStaleReply,
  updateScopeHistory,
} from "../lib/history";
import {
  boardBtn,
  formEl,
  moreBtn,
  moreMenuEl,
  promptEl,
  sendBtn,
  settingsBtn,
  startCardEl,
} from "./dom-refs";
import {
  activeTaskId,
  bumpTurnId,
  currentTurnId,
  history,
  inFlightProposals,
  messageBelongsToActive,
  state,
} from "./state";
import { sendBgChatMsg, setTaskStatus } from "./rpc";
import {
  initSelectionChip,
  renderSelectionChip,
} from "./selection-chip";
import { initSettingsSync, loadSettings } from "./settings-sync";
import { initDictation } from "./dictation-ui";
import {
  appendMessage,
  appendToScope,
  initMessageView,
  persistHistory,
  setLinkNavigator,
  setPreviewActions,
} from "./message-view";
import {
  closeThreadMenu,
  initThreadUi,
  renderActiveThread,
  renderThreadHeader,
  selectAsk,
  startNewEdit,
} from "./thread-ui";
import { initScope, refreshContext } from "./scope";


// Pop-menu toggling lives in ./pop-menu (DOM-only). Inject the two side-panel
// behaviours: disarm the two-click "clear chat" whenever menus close, and close
// the thread dropdown when a "⋯" menu opens (so they never overlap).
setPopMenuCloseHook(disarmClear);
initPopMenuDismissal();
wirePopToggle(moreBtn, moreMenuEl, closeThreadMenu);
initSelectionChip();
initSettingsSync();
initDictation((content) => void appendMessage({ role: "assistant", content }));
initMessageView();
// Same-site reply links reuse the docked tab (see message-view's click handler).
setLinkNavigator((url) => void navigateActiveTab(url));
setPreviewActions({
  onApply: (proposalId, container) => {
    state.applyingProposalId = proposalId;
    if (state.activeThread.kind === "edit") void renderThreadHeader();
    void resolvePreview(proposalId, "apply", container).finally(() => {
      if (state.applyingProposalId === proposalId) state.applyingProposalId = null;
      if (state.activeThread.kind === "edit") void renderThreadHeader();
    });
  },
  onCancel: (proposalId, container) => void resolvePreview(proposalId, "cancel", container),
});
initThreadUi();
initScope();


// The debug bridge (sink + per-scope diagnostic log) lives in ./debug-bridge.
// Wire it with a lazy accessor for the current scope so postDebug can stamp
// events without importing this module's mutable state.currentScope.
initDebug(() => state.currentScope);




/**
 * Send APPLY_PROPOSAL or CANCEL_PROPOSAL to the background and replace
 * the preview message in place with the resolution. Mutates the
 * history array so the persisted transcript also gets the resolved
 * attachment, not the now-stale preview.
 */


async function resolvePreview(
  proposalId: string,
  action: "apply" | "cancel",
  originalNode: HTMLElement,
): Promise<void> {
  if (inFlightProposals.has(proposalId)) {
    dlog(`preview ${action} ignored (already in flight)`, { proposalId });
    return;
  }
  inFlightProposals.add(proposalId);
  // Everything below this point must run inside the try so the finally
  // block always releases the lock - a throw between add() and try
  // would permanently lock the proposal for the panel's lifetime.
  try {
    originalNode.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { b.disabled = true; });
    dlog(`preview ${action}`, { proposalId });

    // Snapshot scope so a tab switch mid-flight doesn't try to mutate the
    // new scope's history (and a no-op DOM update on a now-detached node).
    // The proposal still resolves on the backend; the UI on the originating
    // scope picks it up the next time the user switches back.
    const startScope = state.currentScope;
    // Also snapshot the THREAD this apply belongs to. Switching between edit
    // threads in the same repo doesn't change the scope, so the auto-continue
    // below must confirm we're still on the same thread before firing a
    // follow-up (else it'd retarget the wrong thread/file).
    const startTaskId = activeTaskId();

    const msgType = action === "apply" ? "APPLY_PROPOSAL" : "CANCEL_PROPOSAL";
    const resp = await sendBgChatMsg({ type: msgType, proposalId });

    if (isStaleReply(startScope, state.currentScope)) {
      // User tab-switched mid-Apply/Cancel. The proposal still resolved
      // on the backend (PR opened, file pushed, etc.); update the
      // originating scope's bucket so the resolution is reflected when
      // they switch back. Replace the matching preview row in place
      // (matching by proposalId) so loadScope on return shows the
      // resolved row, not the still-pending preview. Atomic so
      // concurrent persists to the same scope don't clobber each other.
      dlog(`${action} reply persisted to originating scope (tab scope changed since click)`, {
        proposalId, startScope, scope: state.currentScope,
      });
      const isApplyFailure = action === "apply" && !resp.payload.attachment;
      const overlay: ChatMessage = isApplyFailure
        ? { ...resp.payload, attachment: { kind: "preview_resolved", data: { proposalId, outcome: "failed" } } }
        : resp.payload;
      await updateScopeHistory(startScope, (existing) => {
        const idxStored = existing.findIndex((m) => {
          const att = m.attachment;
          if (att?.kind !== "preview" && att?.kind !== "preview_resolved") return false;
          const data = att.data as { proposalId?: string } | undefined;
          return data?.proposalId === proposalId;
        });
        const next = [...existing];
        if (idxStored >= 0) {
          next[idxStored] = { ...next[idxStored], ...overlay, timestamp: next[idxStored].timestamp };
        } else {
          // Preview row was never persisted (e.g. user clicked Apply
          // before the first persistHistory) - append the resolution as
          // a fresh message rather than dropping it.
          next.push({ ...overlay, timestamp: Date.now() });
        }
        return next.map(slimForPersist);
      });
      return;
    }

    // Match by proposalId so a clear-and-resend doesn't accidentally
    // overwrite the wrong row.
    const idx = history.findIndex((m) => {
      const att = m.attachment;
      return att?.kind === "preview"
        && (att.data as PendingProposal | undefined)?.proposalId === proposalId;
    });
    if (idx >= 0) {
      // If the apply FAILED, the response carries an error chat message
      // with no attachment. A naive spread leaves the original `preview`
      // attachment in place - on a tab-switch + loadScope re-render, the
      // Apply/Cancel buttons would reappear with a stale (now-removed
      // from session storage) proposalId, and clicking Apply would hit
      // "Proposal expired". Force the attachment to a resolved-failed
      // marker so the row renders as plain text on every future render.
      const isApplyFailure = action === "apply" && !resp.payload.attachment;
      const overlay: ChatMessage = isApplyFailure
        ? {
            ...resp.payload,
            attachment: { kind: "preview_resolved", data: { proposalId, outcome: "failed" } },
          }
        : resp.payload;
      history[idx] = { ...history[idx], ...overlay, timestamp: history[idx].timestamp };
      await persistHistory();
    }

    // Rebuild the row in place with the resolved content.
    const fresh = document.createElement("div");
    fresh.className = `message ${resp.payload.role}`;
    if (idx >= 0 && history[idx].timestamp != null) {
      const ts = document.createElement("span");
      ts.className = "timestamp";
      ts.textContent = formatTime(history[idx].timestamp!);
      fresh.appendChild(ts);
    }
    const body = document.createElement("span");
    body.className = "body";
    if (resp.payload.role === "assistant") {
      body.classList.add("md");
      body.appendChild(renderMarkdown(resp.payload.content));
    } else {
      appendLinkified(body, resp.payload.content);
    }
    fresh.appendChild(body);
    originalNode.replaceWith(fresh);

    // Auto-open commit/PR url if the setting is on, mirroring the chat
    // reply path.
    const att = resp.payload.attachment;
    if (state.openPrInNewTab && (att?.kind === "pr" || att?.kind === "commit")) {
      const data = att.data as { url?: string };
      if (data?.url) void chrome.tabs.create({ url: data.url, active: true });
    }

    // Small in-thread loop: a step just landed cleanly (commit/PR). Nudge the
    // agent to take the next step needed to finish the original request, or
    // report done. Only on Apply success and only reached on the same-scope
    // path (the stale-scope branch returned above); triggerAutoContinue also
    // re-checks we're still on the SAME thread (a same-scope edit→edit switch
    // mid-apply doesn't trip the stale-scope guard), so we never auto-drive a
    // thread the user has navigated away from.
    if (action === "apply" && (att?.kind === "pr" || att?.kind === "commit")) {
      triggerAutoContinue(startTaskId);
    }
  } finally {
    inFlightProposals.delete(proposalId);
  }
}

// Operator → chat reverse channel (inject prompts / apply-cancel commands via
// the debug bridge) lives in ./reverse-channel. Started here; it's a no-op
// unless the user opted into injection with a loopback sink.
initReverseChannel({ onNewEdit: startNewEdit, onSelectAsk: selectAsk });
initPanelPresence();
initChatActions();

settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Open the tasks board in a full tab. Reuse an existing board tab if one
// is already open so repeated clicks don't pile up duplicates. We only have
// "activeTab" (not "tabs"), so chrome.tabs.query can't filter by url and may
// return tabs with url undefined - re-check url in JS, and fall back to
// opening a fresh tab if the query throws or matches nothing.
boardBtn.addEventListener("click", () => void openBoard());

// Send key behaviour is driven by settings.sendKey (cached in `state.sendKey`):
//   - "enter":     Enter sends, Shift+Enter newlines. Cmd/Ctrl+Enter also
//                  sends for users who have the IDE habit.
//   - "mod-enter": Cmd/Ctrl+Enter sends, plain Enter newlines.
promptEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.shiftKey) return; // newline always wins over Shift+Enter
  const hasMod = e.metaKey || e.ctrlKey;
  if (state.sendKey === "mod-enter") {
    if (!hasMod) return; // plain Enter is a newline in this mode
  }
  // In "enter" mode, both plain Enter and Cmd/Ctrl+Enter submit.
  e.preventDefault();
  if (!state.sending) formEl.requestSubmit();
});

// ── Small in-thread loop: auto-continue after Apply ──────────────────
// After a change lands, nudge the agent to take the NEXT step needed to
// finish the user's original request (add the new page to the menu, fix
// links, etc.) or report done. Every step still previews and waits for the
// user's Apply, so the loop is bounded by their clicks; the streak cap is a
// backstop against the agent proposing busywork indefinitely.
const AUTO_CONTINUE_PROMPT =
  "That change was applied and committed. If any steps remain to fully " +
  "complete what I originally asked for in this thread — for example adding a " +
  "new page to the site menu/navigation, or updating links that point to it — " +
  "do the NEXT step now. If everything I originally asked for is already done, " +
  "just briefly confirm what was completed and stop. Don't invent new work I " +
  "didn't ask for.";
const MAX_AUTO_CONTINUE = 6;

function triggerAutoContinue(expectedTaskId: string | null): void {
  if (!state.autoContinue) return;
  if (state.activeThread.kind !== "edit") return;
  // The apply belonged to `expectedTaskId`; if the user switched to a different
  // edit thread while it was in flight, don't drive the follow-up into the
  // wrong thread (a same-repo edit→edit switch keeps the scope unchanged, so
  // the caller's stale-scope guard can't catch this).
  if (activeTaskId() !== expectedTaskId) {
    dlog("auto-continue skipped - thread changed since apply", { expectedTaskId });
    return;
  }
  if (state.autoContinueStreak >= MAX_AUTO_CONTINUE) {
    dlog("auto-continue capped", { streak: state.autoContinueStreak });
    return;
  }
  if (state.sending) return; // a turn is already in flight
  if (promptEl.value.trim()) return; // don't clobber what the user is typing
  state.pendingAutoContinue = true;
  promptEl.value = AUTO_CONTINUE_PROMPT;
  dlog("auto-continue submit", { streak: state.autoContinueStreak + 1 });
  formEl.requestSubmit();
}

// Single writer of the in-flight lock. state.sending is the source of truth;
// the Send button's disabled attribute is a render of it. Centralizing the write
// here is what lets runChatTurn guarantee the reset in ONE place (the .finally
// below) rather than at every early-return path.
function setSending(v: boolean): void {
  state.sending = v;
  sendBtn.disabled = v;
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  // Duplicate-submit guard. A send stays in flight across several awaits
  // (initialReady, context resolve, the model round-trip); without a lock set
  // BEFORE those awaits, a second click - or an impatient double-tap on a slow
  // send - queued a whole second turn and appended a duplicate message. Claim
  // the lock synchronously here; running the body via .finally clears it on
  // EVERY exit (early return or throw), so there are no per-return resets to
  // forget.
  if (state.sending) return;
  setSending(true);
  void runChatTurn(prompt).finally(() => setSending(false));
});

async function runChatTurn(prompt: string): Promise<void> {
  // Distinguish an automated follow-up from a user-typed send: reset the
  // streak on a real user turn, grow it on each chained auto-continue so the
  // cap in triggerAutoContinue can stop a runaway.
  const isAutoContinue = state.pendingAutoContinue;
  state.pendingAutoContinue = false;
  state.autoContinueStreak = isAutoContinue ? state.autoContinueStreak + 1 : 0;

  // Thread type decides the mode: Ask = read (never edits), edit thread =
  // edit (and a follow-up revises that same task via turnTaskId).
  const isEdit = state.activeThread.kind === "edit";
  const turnTaskId = activeTaskId() ?? undefined;

  // Edit threads need write access; otherwise bounce to Ask.
  if (isEdit && state.canEditCurrentRepo === false) {
    selectAsk();
    await appendMessage({
      role: "assistant",
      content:
        "You have read-only access to this repo, so AI editing is disabled. Ask a question here, or use GitHub with a write-enabled account for manual edits.",
    });
    return;
  }

  // No confirm on send: the Apply button on the proposal preview is the
  // explicit push gate (it names the target — "Apply (push to main)"), so
  // arming the Send button too was redundant friction. Direct-push
  // confirmation, if enabled, now lives on Apply (see renderPreview).
  // Wait for init's first refreshContext to settle state.currentScope.
  // Without this, submitting during the first ~200ms after the panel
  // opens captures `NO_CONTEXT_SCOPE`, and init's later loadScope swap
  // either trips the drift bail (silent prompt-restore) or routes the
  // reply to the no-context bucket where the user never sees it.
  await initialReady;

  // Snapshot scope BEFORE any await. getActiveTabContext can take
  // hundreds of ms (it injects the content script if needed), and a
  // tab switch during that window would silently rebind state.currentScope
  // and route the user's typed prompt to the wrong site's history.
  // Captured here so the drift check below is meaningful.
  const sentScope = state.currentScope;

  let context = await getActiveTabContext();

  if (state.currentScope !== sentScope) {
    // User navigated away while we were resolving context. Restore
    // the prompt so they don't lose what they typed and bail. We can't
    // safely append a "switch back" hint to either scope without
    // muddying one of them, so the dlog line is the only trace. An
    // auto-continue carries no user-typed text, so clear the box instead
    // of leaving the machine prompt in it.
    promptEl.value = isAutoContinue ? "" : prompt;
    dlog("submit aborted (tab scope changed during context resolve)", {
      sentScope, scope: state.currentScope, auto: isAutoContinue,
    });
    return;
  }

  // Committed to this send now that scope is stable: turn the new-request start
  // card into the live conversation. Done here (not at the top) so an aborted
  // send above - a scope drift - keeps the card and the restored prompt. Re-
  // render the header so the banner + context line the card hid come back (the
  // task listener only does that once a task exists; an Ask send or a
  // clarification reply creates none).
  if (state.composing) {
    state.composing = false;
    startCardEl.hidden = true;
    void renderThreadHeader();
  }

  if (!context) {
    // An auto-continue fires without the user asking - if there's no active
    // docs page to ground it (e.g. their active tab is chrome://extensions),
    // abort silently rather than dumping a confusing "open a docs page" line
    // into the thread. The user can continue manually when they're back on
    // the site. A user-typed send still gets the helpful hint.
    if (isAutoContinue) {
      promptEl.value = "";
      dlog("auto-continue aborted - no active docs page context");
      return;
    }
    await appendMessage({
      role: "assistant",
      content: "Open a *.pages.dev docs page in the active tab first.",
      taskId: turnTaskId,
    });
    return;
  }
  // Continuing an EXISTING edit thread: target that task's file, not
  // whatever page happens to be open. (A new edit thread has no task yet,
  // so it uses the live page as its target.)
  if (isEdit && turnTaskId) {
    const t = await getTask(turnTaskId);
    if (t) {
      context = { ...context, sourcePath: t.sourcePath };
      // Sending into a cancelled edit means the user wants to keep working on
      // it - revive it so it isn't frozen on a "Cancelled" badge (and so a new
      // proposal advances a live task, not a dead one). Fire-and-forget; the
      // storage listener re-renders the banner when it lands.
      if (t.status === "cancelled") void setTaskStatus(turnTaskId, "proposed");
    }
  }

  // The adapter receives THIS thread's prior transcript (not other threads'),
  // capped at the last 40 turns. Older turns stay visible in the UI.
  const priorHistory = history.filter(messageBelongsToActive).slice(-40);
  // Stamp this turn so the reply handler can detect a clear-during-flight
  // and drop the orphan response. Per-scope counter so a send on tab B
  // doesn't invalidate tab A's pending reply.
  const turnId = bumpTurnId(sentScope);
  dlog("CHAT_TURN send", {
    turnId,
    scope: sentScope,
    prompt: prompt.slice(0, 80),
    historyCount: priorHistory.length,
    repo: context.repo ? `${context.repo.owner}/${context.repo.name}` : null,
    sourcePath: context.sourcePath,
  });
  await appendMessage({
    role: "user",
    content: prompt,
    taskId: turnTaskId,
    // Record the grounding so it's explicit on the message: the anchored
    // selection (as a quote), or - for an unselected edit - the whole page.
    ...(context.selection
      ? { selection: context.selection }
      : isEdit
        ? { pageContext: { sourcePath: context.sourcePath, title: context.title } }
        : {}),
  });
  promptEl.value = "";
  // The selection (if any) is now captured in `context.selection`; drop the
  // page pin + chip so it doesn't carry into the next, unrelated turn.
  if (context.selection) {
    void clearSelectionInTab();
    renderSelectionChip(null);
  }
  // The in-flight lock (state.sending) is released by the caller's .finally on
  // every exit path, so no reset is needed here.
  const resp = await sendBgChatMsg({
    type: "CHAT_TURN",
    prompt,
    context,
    history: priorHistory,
    mode: isEdit ? "edit" : "read",
    taskId: turnTaskId,
  });
  // Tag the reply to this thread so it renders/persists in the right view.
  const reply: ChatMessage = { ...resp.payload, taskId: turnTaskId };
  if (turnId !== currentTurnId(sentScope)) {
    // The sentScope's chat was cleared (or a newer turn started in
    // the same scope) since we sent. Drop this reply - it would
    // appear orphaned without its prompt context.
    dlog("CHAT_TURN reply dropped (originating scope cleared since send)", {
      turnId, scope: sentScope,
    });
    return;
  }
  if (isStaleReply(sentScope, state.currentScope)) {
    // User tab-switched mid-flight. Reply belongs to the originating
    // scope's conversation - persist it directly to that bucket
    // instead of dropping. They'll see it next time they switch back
    // to that tab. This is the difference between "your message
    // vanished" (terrible) and "your reply is waiting on the other
    // tab" (correct).
    dlog("CHAT_TURN reply persisted to originating scope (tab scope changed since send)", {
      turnId, sentScope, scope: state.currentScope,
      role: reply.role,
      contentPreview: reply.content.slice(0, 80),
    });
    await appendToScope(sentScope, reply);
    return;
  }
  dlog("CHAT_TURN reply", {
    turnId,
    role: reply.role,
    contentPreview: reply.content.slice(0, 120),
    attachment: reply.attachment?.kind,
  });
  await appendMessage(reply);
  // Auto-open the result link (PR url in PR mode, commit url in
  // direct-push mode) when the user has the setting on. Both kinds
  // ship a {url} payload so the open logic is the same; only the
  // attachment.kind differs by commit-mode.
  const att = reply.attachment;
  if (state.openPrInNewTab && (att?.kind === "pr" || att?.kind === "commit")) {
    const data = att.data as { url?: string };
    if (data?.url) void chrome.tabs.create({ url: data.url, active: true });
  }
}

// On open: load settings, then refreshContext - which resolves the
// active tab's scope and loads the matching transcript. We no longer
// load history before knowing the scope (would have shown the wrong
// site's chat for a split second).
//
// `initialReady` is a promise the submit handler awaits BEFORE
// capturing state.currentScope. Without this guard, a fast user can submit
// while state.currentScope is still NO_CONTEXT_SCOPE; init's refreshContext
// then swaps state.currentScope mid-flight and the scope-drift check either
// (a) bails silently with prompt restored, or (b) routes the reply to
// the no-context bucket where the user never sees it. Either way the
// user types something and sees nothing.
const initialReady: Promise<void> = (async () => {
  await loadSettings();
  await refreshContext();
  renderActiveThread();
})();
