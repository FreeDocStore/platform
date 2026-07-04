// Background-RPC helpers used across the side-panel modules. Thin wrappers over
// lib/messaging that own the error/edge-case handling once. Import-safe: no DOM
// or state at module scope.

import type { ChatMessage, RuntimeMessage, TaskStatus } from "../types";
import { sendToBg } from "../lib/messaging";

/**
 * Wrapper around the chat/proposal sendToBg flows that converts a background
 * ERROR_RESULT (or a missing/undefined response - which happens when the SW is
 * killed mid-flight) into a synthetic ChatMessage so callers can render it
 * instead of crashing on `resp.payload`. Without this guard, every uncaught
 * background throw was a silent UI freeze + console TypeError.
 */
export async function sendBgChatMsg(msg: RuntimeMessage): Promise<{ payload: ChatMessage }> {
  let resp: { type?: string; payload?: ChatMessage } | undefined;
  try {
    resp = await sendToBg<{ type?: string; payload?: ChatMessage }>(msg);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      payload: {
        role: "assistant",
        content: `Communication error: ${detail.slice(0, 240)}. The background service worker may have been suspended; try again.`,
        attachment: { kind: "error", data: { action: "open_options" } },
      },
    };
  }
  if (!resp || !resp.payload) {
    return {
      payload: {
        role: "assistant",
        content: "Background returned no response. The service worker may have crashed; check the extension console.",
        attachment: { kind: "error", data: { action: "open_options" } },
      },
    };
  }
  return { payload: resp.payload };
}

// Manually drive an edit's lifecycle stage (Mark done / Reopen / Cancel).
// Routed through the SW for single-writer safety; the storage listener
// re-renders the banner when the change lands.
export async function setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
  try {
    await sendToBg({ type: "SET_TASK_STATUS", taskId, status });
  } catch {
    /* SW unreachable - the storage listener refreshes on the next change */
  }
}
