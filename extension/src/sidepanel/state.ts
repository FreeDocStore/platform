// The side panel's shared mutable state, in one place. Split out of
// sidepanel.ts so the extracted concern modules read/write the SAME state
// instead of each closing over its own module-level `let`. Reassigned scalars
// live on the `state` object (imported bindings can't be written across
// modules, but object fields can); collections that are mutated in place are
// exported as consts.

import type { ChatMessage, PageContext, Settings } from "../types";
import type { ActiveThread } from "./thread-model";
import {
  activeTaskId as computeActiveTaskId,
  messageBelongsTo,
} from "./thread-model";
import { NO_CONTEXT_SCOPE, type Scope } from "../lib/history";

// The single conversation log. Mutated IN PLACE on scope change so every
// caller that closed over it (renderMessage, persistHistory, the apply/cancel
// handlers) keeps a stable reference. Don't reassign - splice/push/length=0.
export const history: ChatMessage[] = [];

// Per-scope monotonic turn ID. Used to invalidate stale CHAT_TURN replies
// after a Clear in the originating scope. Was a single global counter, but that
// meant a send on Tab B would invalidate Tab A's in-flight reply (the global
// counter incremented). Per-scope keeps each conversation's stream independent
// so multi-tab chat works.
export const activeTurnIdByScope = new Map<Scope, number>();
export function bumpTurnId(scope: Scope): number {
  const next = (activeTurnIdByScope.get(scope) ?? 0) + 1;
  activeTurnIdByScope.set(scope, next);
  return next;
}
export function currentTurnId(scope: Scope): number {
  return activeTurnIdByScope.get(scope) ?? 0;
}

// Thin wrappers binding the pure thread-model helpers to the live activeThread,
// so call sites across the panel stay terse.
export const activeTaskId = (): string | null => computeActiveTaskId(state.activeThread);
export const messageBelongsToActive = (msg: ChatMessage): boolean =>
  messageBelongsTo(msg, state.activeThread);

// Per-proposal in-flight lock. Without this, two paths can double-fire the same
// proposalId: (a) loadScope re-renders fresh enabled buttons after the user
// tab-switches mid-Apply (the disabled state was on the detached DOM, not the
// in-memory data), (b) two open side panels both click Apply on the same UUID.
// The second call would get a 409 "stale SHA" or create a duplicate PR. Cleared
// in `finally` so a failed Apply can be retried.
export const inFlightProposals = new Set<string>();

// Per-scope scroll position memory. When the user switches tabs, the scroll
// position of the chat they were reading is saved here and restored on render,
// so "where I was reading" stays stable across tab switches. In-memory only -
// a panel reload resets to bottom, which is the right default for a fresh open.
export const scrollByScope = new Map<Scope, number>();

// Reassigned scalars. Access as `state.x` from every module.
export const state = {
  // The scope (repo+page) the panel is currently showing.
  currentScope: NO_CONTEXT_SCOPE as Scope,

  // The active tab's resolved page context (page/repo/selection), refreshed on
  // every tab change. Read by the new-request start card (context block) and by
  // the message-view link handler (to tell "this docs site" links, which
  // navigate the tab in place, from external ones that open a new tab).
  currentContext: null as PageContext | null,

  // Active thread: a filtered VIEW over `history`, keyed by ChatMessage.taskId.
  // "ask" = the untagged, read-only questions thread; { edit, taskId } = an
  // editable edit thread whose messages carry that taskId. A new edit thread
  // mints its taskId client-side, so the view exists before the task row does
  // (created on the first proposal).
  activeThread: { kind: "ask" } as ActiveThread,
  threadMenuOpen: false,

  // "chat" shows the active thread; "list" shows the in-panel edits backlog for
  // the current repo. Toggled by the ☰ button / banner "≡ Edits" link.
  panelView: "chat" as "chat" | "list",

  // True while composing a brand-new request: the start card overlays the
  // conversation (pick Ask/Edit, see context, how-it-works). Cleared on the
  // first send and when switching to an existing thread.
  composing: false,

  // True while renderActiveThread is bulk-rendering the whole transcript (it
  // force-scrolls to the bottom at the end), so incremental-only affordances
  // like the new-messages chip don't fire for every historical row.
  bulkRendering: false,

  // The proposalId currently being applied, if any. Drives the transient
  // "Applying…" pill in the thread banner so a push-to-main (with visible deploy
  // lag) doesn't feel like the click did nothing.
  applyingProposalId: null as string | null,

  // Debounce timer for mirroring history to the repo store.
  repoMirrorTimer: null as number | null,

  // Monotonic id stamped on each loadScope. If a newer load fires while we are
  // awaiting readScopeHistory, the older call must NOT touch shared state on
  // resume - else it overwrites the new scope's transcript/DOM and appends
  // persist to the wrong bucket. Same pattern as activeRefreshId / turn id.
  activeLoadId: 0,

  // Latest known write-access state for the current repo. null = unknown (not
  // signed in, lookup failed, or no repo). When false, the Edit option in the
  // mode dropdown is disabled.
  canEditCurrentRepo: null as boolean | null,

  // Monotonic id stamped on each refreshContext call. CHECK_PERMISSIONS can
  // take a few hundred ms; without this stamp a slow lookup for repo A can land
  // after the user navigated to repo B and reflect the wrong repo's perms.
  activeRefreshId: 0,

  // Behaviour settings cached in module state so the keydown + submit handlers
  // can read them synchronously. Kept in sync via loadSettings + the
  // storage.onChanged listener.
  sendKey: "enter" as Settings["sendKey"],
  // Default OFF: auto-opening the commit/PR URL in a new tab after every Apply
  // surprised users with unexpected tabs. Opt in via the options checkbox.
  openPrInNewTab: false,
  // Default ON: after an Apply in an edit thread, auto-send a short follow-up so
  // the agent takes the next step to finish the request (small in-thread loop).
  autoContinue: true,
  // Global default commit mode, reflected wherever you Apply (PR <-> Direct).
  commitMode: "pr" as Settings["commitMode"],

  // Two-click "clear chat" arming state: first click arms (3s window), second
  // click within the window actually clears. Prevents accidental transcript loss
  // without spawning an OS dialog.
  clearArmed: false,
  clearArmTimer: null as number | null,

  // Auto-continue loop guard: consecutive auto-continues in a row (capped), and
  // whether one is queued so the submit handler can tell an automated follow-up
  // from a user-typed one.
  autoContinueStreak: 0,
  pendingAutoContinue: false,

  // The signed-in user's GitHub login (lowercase), for avatar attribution on
  // the user's own chat messages. From settings.claude.githubApp.username; null
  // for a bare PAT with no cached login (avatar falls back to a neutral chip).
  myLogin: null as string | null,

  // True while a chat turn is in flight (from submit until the round-trip
  // settles). The single source of truth for "a send is happening" - the Send
  // button's disabled state is a RENDER of this (see setSending), and the
  // keydown / auto-continue / reverse-channel gates read it too. Modeling it as
  // real state (not a DOM property) is what lets the submit handler guarantee
  // the reset in one finally instead of at every early return.
  sending: false,
};
