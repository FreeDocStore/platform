import type { Scope } from "../lib/history";
import type { ActiveThread } from "./thread-model";

const drafts = new Map<string, string>();

function key(scope: Scope, thread: ActiveThread): string | null {
  return thread.kind === "edit" ? JSON.stringify([scope, thread.taskId]) : null;
}

export function getAttachedDraft(scope: Scope, thread: ActiveThread): string | null {
  const id = key(scope, thread);
  return id ? drafts.get(id) ?? null : null;
}

export function attachDraft(scope: Scope, taskId: string, text: string): void {
  drafts.set(JSON.stringify([scope, taskId]), text);
}

export function beginEditFromReply(
  scope: Scope,
  text: string,
  startNewEdit: () => void,
  activeThread: () => ActiveThread,
  onAttached: () => void,
): void {
  if (!text.trim()) return;
  startNewEdit();
  const thread = activeThread();
  if (thread.kind !== "edit") return;
  attachDraft(scope, thread.taskId, text);
  onAttached();
}

export function removeAttachedDraft(scope: Scope, thread: ActiveThread): void {
  const id = key(scope, thread);
  if (id) drafts.delete(id);
}

/** Consume the attachment only after the request has completed successfully. */
export function completeDraftSend(scope: Scope, thread: ActiveThread, succeeded: boolean): void {
  if (succeeded) removeAttachedDraft(scope, thread);
}
