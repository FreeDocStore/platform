// In-panel edits list: the current repo's edit threads (every non-cancelled
// task stage + orphan draft threads), newest-first, each row navigable to its
// thread. The in-panel counterpart to the board's List view. Pure rendering:
// it takes the data + callbacks and builds DOM, no module state / storage /
// chrome access - the side panel gathers the data and wires the actions. This
// is the render pattern the in-panel kanban view will reuse.

import type { Task } from "../types";
import { statusLabelFor, statusColor } from "../lib/task-format";

export interface EditsListView {
  /** Container to render into (cleared first). */
  container: HTMLElement;
  /** Repo of the page on the left, or null when there's no page context. */
  repo: { owner: string; name: string } | null;
  /** Real tasks for this repo (non-cancelled stages), newest-first. */
  tasks: Task[];
  /** Thread ids present in history but with no task row yet (drafts). */
  orphanIds: string[];
  /** Display label for an orphan draft thread id. */
  fallbackLabel: (id: string) => string;
  onNewEdit: () => void;
  onOpenBoard: (repoKey?: string) => void;
  onSelectEdit: (taskId: string) => void;
  onArchive: (taskId: string) => void;
}

export function renderEditsList(v: EditsListView): void {
  v.container.replaceChildren();

  const head = document.createElement("div");
  head.className = "edits-head";
  const title = document.createElement("span");
  title.className = "edits-title";
  title.textContent = v.repo ? `Edits · ${v.repo.owner}/${v.repo.name}` : "Edits";
  head.appendChild(title);
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "edits-new";
  newBtn.textContent = "＋ New edit";
  newBtn.addEventListener("click", () => v.onNewEdit());
  head.appendChild(newBtn);
  const backlog = document.createElement("button");
  backlog.type = "button";
  backlog.className = "edits-backlog";
  backlog.textContent = "Backlog ↗";
  backlog.title = "Open the full board in a new tab";
  const repoKey = v.repo ? `${v.repo.owner}/${v.repo.name}` : undefined;
  backlog.addEventListener("click", () => v.onOpenBoard(repoKey));
  head.appendChild(backlog);
  v.container.appendChild(head);

  if (v.tasks.length === 0 && v.orphanIds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "edits-empty";
    empty.textContent = "No edits yet for this page's repo. Start one with ＋ New edit.";
    v.container.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "edits-rows";
  for (const t of v.tasks) {
    list.appendChild(
      editRow(v, t.id, t.title, { text: statusLabelFor(t.status), color: statusColor(t.status) }, t.sourcePath, t.selection, true),
    );
  }
  for (const id of v.orphanIds) {
    list.appendChild(
      editRow(v, id, v.fallbackLabel(id), { text: "Draft", color: "var(--text-muted)" }, undefined, null, false),
    );
  }
  v.container.appendChild(list);
}

function editRow(
  v: EditsListView,
  taskId: string,
  title: string,
  status: { text: string; color: string },
  sourcePath?: string,
  selection?: { text: string; heading?: string } | null,
  archivable = false,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "edit-row";
  row.tabIndex = 0;
  const open = () => v.onSelectEdit(taskId);
  row.addEventListener("click", open);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });

  const top = document.createElement("div");
  top.className = "edit-row-top";
  const chip = document.createElement("span");
  chip.className = "edit-row-status";
  chip.textContent = status.text;
  chip.style.color = status.color;
  chip.style.borderColor = status.color;
  top.appendChild(chip);
  const t = document.createElement("span");
  t.className = "edit-row-title";
  t.textContent = title;
  top.appendChild(t);
  if (archivable) {
    const arch = document.createElement("button");
    arch.type = "button";
    arch.className = "edit-row-archive";
    arch.textContent = "Archive";
    arch.title = "Hide this edit from the list (keeps the record)";
    arch.addEventListener("click", (e) => {
      e.stopPropagation();
      v.onArchive(taskId);
    });
    top.appendChild(arch);
  }
  row.appendChild(top);

  // Context line: page › section › "sentence".
  const crumb = [
    sourcePath,
    selection?.heading,
    selection?.text ? `"${selection.text.length > 50 ? selection.text.slice(0, 47) + "…" : selection.text}"` : null,
  ].filter(Boolean);
  if (crumb.length) {
    const meta = document.createElement("div");
    meta.className = "edit-row-meta";
    meta.textContent = crumb.join("  ›  ");
    row.appendChild(meta);
  }

  return row;
}
