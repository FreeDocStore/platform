// Pure thread-model logic for the side panel: which messages belong to which
// thread view, deriving "draft" threads from tagged history, and filtering
// tasks to a repo. Extracted from sidepanel.ts so this branchy logic can be
// unit-tested without a DOM. The side panel keeps thin wrappers that feed in
// its mutable `activeThread` / `history` state.

import type { ChatMessage, Task } from "../types";

// A thread is a filtered VIEW over one scope's transcript: "ask" shows the
// untagged messages (read-only Q&A); an "edit" thread shows messages tagged
// with its taskId.
export type ActiveThread = { kind: "ask" } | { kind: "edit"; taskId: string };

export function activeTaskId(active: ActiveThread): string | null {
  return active.kind === "edit" ? active.taskId : null;
}

/** Does this message belong to the given thread view? */
export function messageBelongsTo(msg: ChatMessage, active: ActiveThread): boolean {
  return active.kind === "ask" ? !msg.taskId : msg.taskId === active.taskId;
}

// Distinct taskIds that appear in the transcript, first-seen order. Some have
// no task row: an edit thread whose first turn returned a clarification/error
// never creates a task, but its messages are still tagged. Surfacing these
// keeps that conversation reachable instead of stranded.
export function threadIdsInHistory(history: ChatMessage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of history) {
    if (m.taskId && !seen.has(m.taskId)) {
      seen.add(m.taskId);
      out.push(m.taskId);
    }
  }
  return out;
}

// A label for a thread with no task row yet, derived from its first user
// message (a real task's title normally fills this role).
export function threadFallbackLabel(history: ChatMessage[], taskId: string): string {
  const firstUser = history.find((m) => m.taskId === taskId && m.role === "user");
  const s = (firstUser?.content ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "Untitled edit";
  return s.length > 40 ? s.slice(0, 39) + "…" : s;
}

/** Active (non-cancelled, non-archived) tasks for a repo, newest-updated first. */
export function threadsForRepo(tasks: Task[], repoKey: string): Task[] {
  return tasks
    .filter((t) => t.repo === repoKey && t.status !== "cancelled" && !t.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
