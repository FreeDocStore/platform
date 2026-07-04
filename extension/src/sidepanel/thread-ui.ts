// Thread UI: the thread selector dropdown, the contextual edit banner, the
// in-panel edits list (backlog), and the selection/navigation between threads.
//
// A thread is a filtered VIEW over `history` keyed by the message's taskId
// (see ChatMessage.taskId): Ask = untagged messages (read mode, never edits);
// an edit thread = messages tagged with its task id (edit mode, follow-ups
// revise the SAME task). This reuses the whole preview/Apply machinery instead
// of a parallel store.
//
// Extracted from sidepanel.ts. Imports message-view (renderMessage etc.) and the
// pure renderers; the conversation core / scope import the exports here. Wiring
// (selector click, click-away, TASKS storage listener) is set up by
// initThreadUi() so nothing runs at import time.

import type { RuntimeMessage, Task } from "../types";
import { state, history, messageBelongsToActive } from "./state";
import { renderMessage, hideNewBelowChip, appendMessage } from "./message-view";
import { refreshSelectionChip, renderSelectionChip } from "./selection-chip";
import { setTaskStatus } from "./rpc";
import { sendToBg } from "../lib/messaging";
import {
  bannerEl,
  commitModeToggle,
  contextSectionEl,
  editsBtn,
  editsListEl,
  messagesEl,
  promptEl,
  startCardEl,
  threadMenuEl,
  threadSelectEl,
} from "./dom-refs";
import { openEditSection, navigateActiveTab, focusEditInTab, clearSelectionInTab } from "./tab-messaging";
import { renderStartCard, type StartCardContext } from "./start-card";
import { sourceToPublishedPath } from "../resolver";
import {
  threadIdsInHistory as computeThreadIdsInHistory,
  threadFallbackLabel as computeThreadFallbackLabel,
  threadsForRepo,
} from "./thread-model";
import { renderThreadBanner as renderThreadBannerView } from "./thread-banner";
import { renderEditsList as renderEditsListView } from "./edits-list";
import { openBoard } from "./board-nav";
import { closeAllPopMenus } from "./pop-menu";
import { statusColor, statusLabelFor } from "./format";
import { getTask, listTasks, TASKS_KEY } from "../lib/tasks";
import { repoFromScope } from "../lib/history";

// Archive/unarchive an edit via the SW (single-writer). On archiving the active
// thread, drop back to the edits list so we're not sitting on a hidden thread.
// Best-effort; the storage-change listener re-renders the views.
async function setTaskArchived(taskId: string, archived: boolean): Promise<void> {
  try {
    await sendToBg({ type: "SET_TASK_ARCHIVED", taskId, archived });
  } catch {
    /* SW unreachable - ignore */
  }
  if (archived && state.activeThread.kind === "edit" && state.activeThread.taskId === taskId) {
    showListView();
  }
}

export async function threadsForCurrentRepo(): Promise<Task[]> {
  const repo = repoFromScope(state.currentScope);
  if (!repo) return [];
  const tasks = await listTasks();
  return threadsForRepo(tasks, `${repo.owner}/${repo.name}`);
}

// Thin wrappers binding the pure thread-model helpers (see ./thread-model) to
// the panel's live `history`, so call sites stay terse.
const threadIdsInHistory = (): string[] => computeThreadIdsInHistory(history);
const threadFallbackLabel = (taskId: string): string =>
  computeThreadFallbackLabel(history, taskId);

/** Re-render the messages column to just the active thread's messages. */
export function renderActiveThread(): void {
  messagesEl.innerHTML = "";
  // Opening/switching a thread always lands at the newest message (bottom).
  state.bulkRendering = true;
  for (const m of history) if (messageBelongsToActive(m)) renderMessage(m);
  state.bulkRendering = false;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  hideNewBelowChip();
  void renderThreadHeader();
}

// The thread selector button + its pop-up list, and the contextual banner.
export function closeThreadMenu(): void {
  threadMenuEl.hidden = true;
  state.threadMenuOpen = false;
}

export async function renderThreadHeader(): Promise<void> {
  // Selector label.
  if (state.activeThread.kind === "ask") {
    threadSelectEl.textContent = "❓ Ask ▾";
    bannerEl.hidden = true;
    commitModeToggle.hidden = true;
    contextSectionEl.hidden = false;
  } else {
    const task = await getTask(state.activeThread.taskId);
    const label = task ? task.title : threadFallbackLabel(state.activeThread.taskId);
    threadSelectEl.textContent = `✎ ${label} ▾`;
    commitModeToggle.hidden = false;
    // A real task banner already shows the target path, so drop the separate
    // context line to save a row. Keep it for a brand-new/draft edit thread,
    // where the banner has no path yet and the context line tells the user
    // which page they're about to edit.
    contextSectionEl.hidden = !!task;
    renderThreadBanner(task, state.activeThread.taskId);
  }
  // Runs last so it can override the banner/context visibility above when the
  // start card is showing (composing a new request).
  updateStartCard();
}

/** Build the start card's context block from the active tab's page context. */
function buildStartContext(): StartCardContext | null {
  const ctx = state.currentContext;
  if (!ctx) return null;
  // Prefer the deployed page path (e.g. /about/) derived from the source file;
  // fall back to the raw URL pathname.
  let path: string | null = null;
  try {
    path = new URL(ctx.url).pathname;
  } catch {
    path = null;
  }
  const pub = ctx.sourcePath ? sourceToPublishedPath(ctx.sourcePath) : null;
  if (pub) path = pub;
  return {
    title: ctx.title || undefined,
    path,
    repoLabel: ctx.repo ? `${ctx.repo.owner}/${ctx.repo.name}` : null,
    selectionText: ctx.selection?.text ?? null,
  };
}

/** Show/refresh the new-request start card, or hide it when not composing. */
function updateStartCard(): void {
  if (!state.composing) {
    startCardEl.hidden = true;
    return;
  }
  renderStartCard({
    container: startCardEl,
    mode: state.activeThread.kind === "edit" ? "edit" : "ask",
    canEdit: state.canEditCurrentRepo !== false,
    context: buildStartContext(),
    onPickAsk: () => selectAsk(true),
    onPickEdit: () => startNewEdit(),
    // Discard: nothing was created yet (no task, no messages), so just leave
    // compose mode. Land on the edits backlog when the repo has edits, else the
    // read-only Ask thread.
    onDiscard: () => void discardComposition(),
  });
  startCardEl.hidden = false;
  // The card carries its own richer context + banner-equivalent, so drop the
  // thin context line and the thread banner while it's up.
  contextSectionEl.hidden = true;
  bannerEl.hidden = true;
}

/**
 * Abandon a new request opened by mistake. Nothing was persisted yet (a
 * brand-new thread has no task and no messages), so this just leaves compose
 * mode - landing on the edits backlog when the repo has edits, else Ask.
 */
async function discardComposition(): Promise<void> {
  state.composing = false;
  // Release the pinned selection so the in-page "✎ Ask / Edit" button can
  // reappear on the next highlight. Without this the pin persists in the page
  // and positionFloatBtn keeps the button hidden - so after a cancel it never
  // comes back. (Chip is cleared too so the composer doesn't keep showing it.)
  void clearSelectionInTab();
  renderSelectionChip(null);
  const threads = await threadsForCurrentRepo();
  if (threads.length > 0) showListView();
  else selectAsk();
}

/**
 * Banner for an edit thread. `task` is null for a thread with no task row yet:
 * either a brand-new edit (no messages) or a "draft" whose first turn was a
 * clarification/error (has messages but never produced a proposal).
 */
function renderThreadBanner(task: Task | null, taskId?: string): void {
  const isDraft = !task && !!taskId && history.some((m) => m.taskId === taskId);
  renderThreadBannerView({
    container: bannerEl,
    task,
    taskId,
    isDraft,
    applying: state.applyingProposalId !== null && !!task,
    onOpenSection: (id) => void openEditSection(id),
    onOpenPage: (url) => void navigateActiveTab(url),
    onSetStatus: (id, next) => void setTaskStatus(id, next),
    onArchive: (id) => void setTaskArchived(id, true),
    beforeMenuOpen: closeThreadMenu,
  });
}

// ── selection / navigation ───────────────────────────────────────────

export function selectAsk(compose = false): void {
  state.activeThread = { kind: "ask" };
  // `compose` = reached via the start card's Ask toggle: keep the card up (now
  // in Ask mode). Any other path (dropdown, permission bounce) exits composing.
  state.composing = compose;
  state.autoContinueStreak = 0; // the cap is per-thread; don't carry it across a switch
  closeThreadMenu();
  showChatView();
  renderActiveThread();
  void refreshSelectionChip(); // update the whole-page/selection indicator
  void focusEditInTab(null); // drop the in-page focus outline
}

export function selectEdit(taskId: string): void {
  state.activeThread = { kind: "edit", taskId };
  state.composing = false; // viewing an existing edit thread, not composing
  state.autoContinueStreak = 0; // the cap is per-thread; don't carry it across a switch
  closeThreadMenu();
  showChatView();
  renderActiveThread();
  void refreshSelectionChip(); // show "whole page" hint when nothing is selected
  void focusEditInTab(taskId); // highlight + scroll to this edit's section
}

export function startNewEdit(): void {
  // Don't let a read-only user start an edit, type a whole request, and only
  // get bounced to Ask on Send. Tell them up front and stay on Ask.
  if (state.canEditCurrentRepo === false) {
    closeThreadMenu();
    showChatView();
    void appendMessage({
      role: "assistant",
      content: "You have read-only access to this repo, so AI editing is disabled. Manual edits should happen in GitHub with an account that has write access.",
    });
    return;
  }
  // Mint the task id client-side so the thread exists in the UI before the
  // task does; the first proposal creates the task under this same id.
  state.activeThread = { kind: "edit", taskId: crypto.randomUUID() };
  state.composing = true; // show the new-request start card until the first send
  state.autoContinueStreak = 0; // fresh thread starts with a fresh auto-continue budget
  closeThreadMenu();
  showChatView();
  renderActiveThread();
  promptEl.focus();
  void refreshSelectionChip(); // surface the whole-page context hint right away
  void focusEditInTab(null); // no task/selection yet — nothing to highlight
}

// ── In-panel edits list (backlog for the current repo) ───────────────

export function showChatView(): void {
  state.panelView = "chat";
  document.body.classList.remove("list-mode");
}

export function showListView(): void {
  state.panelView = "list";
  state.composing = false; // leaving compose to browse the edits backlog
  startCardEl.hidden = true;
  closeThreadMenu();
  document.body.classList.add("list-mode");
  void renderEditsList();
}

// Gather this repo's edit threads (real tasks + orphan drafts) and hand them to
// the pure renderer in ./edits-list, wiring the row actions back to the panel.
export async function renderEditsList(): Promise<void> {
  const repo = repoFromScope(state.currentScope);
  const tasks = await threadsForCurrentRepo();
  const taskIds = new Set(tasks.map((t) => t.id));
  const orphanIds = threadIdsInHistory().filter((id) => !taskIds.has(id));
  renderEditsListView({
    container: editsListEl,
    repo,
    tasks,
    orphanIds,
    fallbackLabel: threadFallbackLabel,
    onNewEdit: startNewEdit,
    onOpenBoard: (repoKey) => void openBoard(repoKey),
    onSelectEdit: selectEdit,
    onArchive: (id) => void setTaskArchived(id, true),
  });
}

/** Build + open the thread list (Ask, edit threads, + New edit). */
async function openThreadMenu(): Promise<void> {
  const tasks = await threadsForCurrentRepo();
  threadMenuEl.replaceChildren();

  const addRow = (
    label: string,
    active: boolean,
    onClick: () => void,
    dot?: string,
    dotColor?: string,
    status?: { text: string; color: string },
  ) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "thread-item" + (active ? " active" : "");
    if (dot) {
      const d = document.createElement("span");
      d.className = "dot";
      d.textContent = dot;
      if (dotColor) d.style.color = dotColor;
      row.appendChild(d);
    }
    const l = document.createElement("span");
    l.className = "label";
    l.textContent = label;
    row.appendChild(l);
    // Status chip on the right so every edit shows its stage at a glance.
    if (status) {
      const s = document.createElement("span");
      s.className = "thread-status";
      s.textContent = status.text;
      s.style.color = status.color;
      row.appendChild(s);
    }
    row.addEventListener("click", onClick);
    threadMenuEl.appendChild(row);
  };

  addRow("❓ Ask — questions (read-only)", state.activeThread.kind === "ask", () => selectAsk());

  // Draft threads: taskIds that exist only as tagged history messages (no task
  // row - their first turn was a clarification/error). List them alongside real
  // tasks so the conversation is always reachable.
  const taskIds = new Set(tasks.map((t) => t.id));
  const orphanIds = threadIdsInHistory().filter((id) => !taskIds.has(id));

  if (tasks.length || orphanIds.length) {
    const sep = document.createElement("div");
    sep.className = "thread-sep";
    threadMenuEl.appendChild(sep);
    for (const t of tasks) {
      addRow(
        t.title,
        state.activeThread.kind === "edit" && state.activeThread.taskId === t.id,
        () => selectEdit(t.id),
        "✎",
        statusColor(t.status),
        { text: statusLabelFor(t.status), color: statusColor(t.status) },
      );
    }
    for (const id of orphanIds) {
      addRow(
        threadFallbackLabel(id),
        state.activeThread.kind === "edit" && state.activeThread.taskId === id,
        () => selectEdit(id),
        "✎",
        "var(--text-muted)",
        { text: "Draft", color: "var(--text-muted)" },
      );
    }
  }
  const sep2 = document.createElement("div");
  sep2.className = "thread-sep";
  threadMenuEl.appendChild(sep2);
  addRow("＋ New edit", false, () => startNewEdit());

  threadMenuEl.hidden = false;
  state.threadMenuOpen = true;
}

/** Wire the edits toggle, thread selector, click-away, and TASKS storage sync. */
export function initThreadUi(): void {
  editsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.panelView === "list") showChatView();
    else showListView();
  });

  threadSelectEl.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllPopMenus(); // don't leave a header "⋯" menu open behind the thread list
    if (state.threadMenuOpen) closeThreadMenu();
    else void openThreadMenu();
  });
  // Click-away closes the menu.
  document.addEventListener("click", () => {
    if (state.threadMenuOpen) closeThreadMenu();
  });

  // The in-page highlight's 💬 button asks the panel to open that edit's thread.
  chrome.runtime.onMessage.addListener((msg: { type?: string; taskId?: string }) => {
    if (msg?.type === "FOCUS_EDIT_THREAD" && typeof msg.taskId === "string") {
      showChatView();
      selectEdit(msg.taskId);
    }
  });

  // The in-page "✎ Edit this" button pins a selection and broadcasts it.
  // "Edit this" means: start a NEW edit targeting this selection, via the SAME
  // unified start card as "＋ New edit" - not a selection chip layered on top of
  // whatever edit thread or the list happened to be open (which is what made it
  // confusing: a new-edit context appearing while an existing edit/list showed).
  chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
    if (msg.type !== "SELECTION_RESULT") return;
    const sel = msg.payload;
    if (!sel) { renderSelectionChip(null); return; }
    // Reflect the pinned selection in the live context so the start card's
    // target block shows it immediately (before the next context poll).
    if (state.currentContext) {
      state.currentContext = { ...state.currentContext, selection: sel };
    }
    // Open the unified new-edit compose (fresh edit thread + start card,
    // replacing the list/existing thread). Don't reset an edit compose already
    // in progress - the user may just be attaching a selection to it.
    const alreadyComposingEdit = state.composing && state.activeThread.kind === "edit";
    if (!alreadyComposingEdit) startNewEdit();
    renderSelectionChip(sel);
    updateStartCard();
  });

  // When tasks change in storage (propose/apply/cancel anywhere), refresh the
  // header/banner. If the currently-open thread's task vanished, fall back to
  // Ask so we don't strand the user on a dead thread.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[TASKS_KEY]) return;
    if (state.activeThread.kind === "edit") {
      void getTask(state.activeThread.taskId).then((t) => {
        // Task cancelled here or on the board: don't strand the user on a dead,
        // still-sendable thread - snap back to Ask (it also drops out of the
        // dropdown, so there'd be no way back to it otherwise).
        if (t && t.status === "cancelled") {
          selectAsk();
          return;
        }
        // A brand-new / draft edit thread has no task row yet - leave it be.
        if (t) void renderThreadHeader();
      });
    }
    if (state.threadMenuOpen) void openThreadMenu();
    if (state.panelView === "list") void renderEditsList();
  });
}
