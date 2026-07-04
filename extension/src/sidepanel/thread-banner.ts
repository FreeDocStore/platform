// The edit-thread banner: a single row with the status pill, the editing-
// context breadcrumb (page › section › "sentence"), inline PR/commit links, and
// a "⋯" overflow of the rarely-used actions (open page, lifecycle stage
// changes, archive). Pure renderer extracted from sidepanel.ts: it takes the
// task + precomputed flags + action callbacks and builds DOM; the panel owns
// the state (history/applyingProposalId) and wires the actions.

import type { Task, TaskStatus } from "../types";
import { statusLabelFor } from "../lib/task-format";
import { publishedUrlForTask } from "./format";
import { wirePopToggle } from "./pop-menu";

export interface ThreadBannerView {
  /** The banner container (cleared and shown). */
  container: HTMLElement;
  /** The thread's task, or null for a brand-new/draft thread. */
  task: Task | null;
  /** The thread's task id (present even before the task row exists). */
  taskId?: string;
  /** True when there's no task yet but the thread has messages (a draft). */
  isDraft: boolean;
  /** True while an Apply for this thread is in flight (shows "Applying…"). */
  applying: boolean;
  onOpenSection: (taskId: string) => void;
  onOpenPage: (url: string) => void;
  onSetStatus: (taskId: string, next: TaskStatus) => void;
  onArchive: (taskId: string) => void;
  /** Runs just before the "⋯" menu opens (close the thread dropdown). */
  beforeMenuOpen: () => void;
}

export function renderThreadBanner(v: ThreadBannerView): void {
  const { task, taskId } = v;
  v.container.replaceChildren();

  // Row 1 — status + the editing-context breadcrumb: page › section › sentence.
  const row1 = document.createElement("div");
  row1.className = "t-row";
  // A prominent, always-visible status pill (colored background, not just
  // colored text) so the stage of the edit you're in is never a guess. While
  // an Apply is in flight it shows a transient "Applying…".
  const statusKey = v.applying ? "applying" : task ? task.status : v.isDraft ? "draft" : "new";
  const badge = document.createElement("span");
  badge.className = `t-badge status-${statusKey}`;
  badge.textContent = v.applying
    ? "Applying…"
    : task ? statusLabelFor(task.status) : v.isDraft ? "Draft" : "New edit";
  row1.appendChild(badge);

  const parts: string[] = [];
  parts.push(`📄 ${task ? task.sourcePath : v.isDraft ? "draft — continue below" : "describe the change to start"}`);
  if (task?.selection?.heading) parts.push(task.selection.heading);
  if (task?.selection?.text) {
    const s = task.selection.text;
    parts.push(`"${s.length > 60 ? s.slice(0, 57) + "…" : s}"`);
  }
  // The breadcrumb navigates to the section when there's a page anchor.
  const canNav = !!task?.pageUrl && !!taskId;
  const crumb = document.createElement(canNav ? "a" : "span") as HTMLElement;
  crumb.className = "t-crumb" + (canNav ? " t-crumb-nav" : "");
  crumb.textContent = parts.join("  ›  ");
  if (canNav) {
    (crumb as HTMLAnchorElement).href = "#";
    crumb.title = "Open the published page for this edit";
    crumb.addEventListener("click", (e) => {
      e.preventDefault();
      v.onOpenSection(taskId!);
    });
  }
  row1.appendChild(crumb);

  // Result links stay inline on the same row - a read-only glance at where the
  // change landed. PR / commit live on GitHub, so those open in a new tab.
  const linkInto = (parent: HTMLElement, url: string, text: string) => {
    if (!/^https:\/\//i.test(url)) return;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = text;
    parent.appendChild(a);
  };
  if (task?.pr) linkInto(row1, task.pr.url, `PR #${task.pr.number}`);
  if (task?.commit) linkInto(row1, task.commit.url, `Commit ${task.commit.sha.slice(0, 7)}`);

  const spacer = document.createElement("span");
  spacer.className = "t-spacer";
  row1.appendChild(spacer);

  // Everything you touch rarely - open the page, lifecycle stage changes,
  // archive - collapses into one "⋯" overflow so the banner stays a single
  // row. ("All edits" is not here: it's the ☰ button in the header.)
  const actions: HTMLElement[] = [];
  const menuAction = (label: string, title: string, onClick: () => void): HTMLElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-item";
    b.setAttribute("role", "menuitem");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", () => onClick());
    return b;
  };
  // "Open page" is the edited file's PUBLISHED page - navigate the docked tab
  // in place (not a new tab), same as clicking the breadcrumb. Derived from the
  // source path so it lands on the page you changed (e.g. /about/), not on
  // wherever you were when you made the edit.
  const openUrl = publishedUrlForTask(task);
  if (openUrl && /^https:\/\//i.test(openUrl)) {
    actions.push(menuAction("📄 Open page", "Open this page in the current tab", () => v.onOpenPage(openUrl)));
  }
  // Stage controls — let the user drive the lifecycle the automatic
  // apply/PR transitions can't (a merged PR -> Done, reopen a finished edit).
  if (task && taskId && !v.applying) {
    const stage = (label: string, next: TaskStatus, title: string) =>
      actions.push(menuAction(label, title, () => v.onSetStatus(taskId, next)));
    if (task.status === "in_review" || task.status === "deployed") {
      stage("✓ Mark done", "done", "Mark this edit complete (e.g. PR merged / deploy verified)");
    }
    // Both finished (done) and abandoned (cancelled) edits can be revived. A
    // cancelled edit never applied, so it reopens to "proposed" - otherwise
    // the thread is a dead-end: still on screen and sendable, but frozen on a
    // "Cancelled" badge with no way forward.
    if (task.status === "done" || task.status === "cancelled") {
      stage("↩ Reopen", task.pr ? "in_review" : task.commit ? "deployed" : "proposed", "Move this edit back to active");
    }
    if (task.status === "proposed" || task.status === "in_review" || task.status === "deployed") {
      stage("✕ Cancel", "cancelled", "Abandon this edit");
    }
  }
  // Archive this edit (only meaningful once it's a real task).
  if (task && taskId) {
    actions.push(menuAction("🗄 Archive", "Hide this edit from the active list (keeps the record)", () => v.onArchive(taskId)));
  }

  if (actions.length) {
    const wrap = document.createElement("div");
    wrap.className = "pop-wrap";
    const moreB = document.createElement("button");
    moreB.type = "button";
    moreB.className = "icon-btn t-more";
    moreB.textContent = "⋯";
    moreB.title = "Edit actions";
    moreB.setAttribute("aria-haspopup", "menu");
    const menu = document.createElement("div");
    menu.className = "pop-menu pop-menu-right";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    for (const a of actions) menu.appendChild(a);
    wrap.appendChild(moreB);
    wrap.appendChild(menu);
    wirePopToggle(moreB, menu, v.beforeMenuOpen);
    row1.appendChild(wrap);
  }

  v.container.appendChild(row1);
  v.container.hidden = false;
}
