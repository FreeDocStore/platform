// Pure presentation helpers for tasks, shared by the tasks board, the side
// panel, and (soon) the in-panel kanban. No DOM / chrome / module state, so
// it's safe to import from any surface and unit-testable directly.
//
// This is the single home for "how a task status reads/colors" and "how old is
// this" - previously duplicated as board.ts#statusLabel and format.ts#
// statusLabelFor, which drifted (one returned raw "cancelled", the other
// "Cancelled").

import type { TaskStatus } from "../types";

/** Human-readable label for a task status. */
export function statusLabelFor(s: TaskStatus): string {
  const map: Record<TaskStatus, string> = {
    proposed: "Proposed",
    in_review: "In review",
    deployed: "Deployed",
    done: "Done",
    cancelled: "Cancelled",
  };
  return map[s] ?? s;
}

/** CSS color for a task-status indicator (accent once it's headed live). */
export function statusColor(s: TaskStatus): string {
  if (s === "in_review" || s === "deployed" || s === "done") return "var(--accent)";
  return "var(--text-muted)";
}

/** Compact relative age, e.g. "just now", "5m ago", "3h ago", "2d ago". */
export function ageLabel(ts: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
