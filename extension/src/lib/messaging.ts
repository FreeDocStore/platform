// One-line wrapper around chrome.runtime.sendMessage for the UI pages that talk
// to the background service worker. Keeps the `as Promise<T>` cast in one place
// (MV3 returns a promise when no callback is passed). Import-safe: `chrome` is
// only referenced inside the function body.

import type { RuntimeMessage } from "../types";

/** Send a message to the background service worker and await its reply. */
export async function sendToBg<T = unknown>(msg: RuntimeMessage): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}
