// Trust classification for incoming runtime messages. Pure and side-effect
// free so it can be unit-tested; the service worker maps each verdict to an
// action (drop silently / refuse with an error / handle).

// Message types a content script is allowed to send. Content scripts run on
// attacker-controllable *.pages.dev pages, so they get a minimal allowlist.
// Everything else (settings read/write, apply/commit, persist) requires a
// trusted extension-page sender (side panel / options / board).
export const CONTENT_SCRIPT_ALLOWED: ReadonlySet<string> = new Set([
  "READ_REPO_FILE",
  "SELECTION_RESULT",
  "OPEN_BOARD", // in-page marker click; just opens an extension page
  "IS_PANEL_OPEN", // read-only: only reveals whether the panel is open here
  "FOCUS_EDIT_THREAD", // in-page highlight button; asks the panel to open a thread
]);

/** The subset of chrome.runtime.MessageSender this guard needs. */
export interface GuardSender {
  id?: string;
  tab?: unknown;
  url?: string;
}

export type SenderVerdict = "drop" | "refuse" | "allow";

/**
 * Classify a message by its sender's trust level.
 *
 * - "drop": not from our own extension - ignore silently.
 * - "refuse": a content script trying a privileged message - reject.
 * - "allow": handle it.
 *
 * The key subtlety: BOTH content scripts and some extension pages carry a
 * `sender.tab`. Content scripts run inside a web page; but the OPTIONS page
 * (opened via chrome.runtime.openOptionsPage) and the board page also live in
 * TABS. So `sender.tab !== undefined` alone wrongly classifies the options
 * page as a content script - which silently refused every SET_SETTINGS /
 * GET_SETTINGS and made settings appear to "save" while nothing persisted.
 *
 * A real content script's `sender.url` is the (http/https) web-page URL; our
 * extension pages report our own `chrome-extension://<id>/` origin, which the
 * page cannot spoof (Chrome sets it). So an extension-page origin is the
 * reliable "trusted" signal even when a tab is present.
 */
export function classifyMessage(
  msgType: string,
  sender: GuardSender,
  extensionId: string,
): SenderVerdict {
  if (sender.id !== extensionId) return "drop";
  const fromExtensionPage = (sender.url ?? "").startsWith(`chrome-extension://${extensionId}/`);
  const fromContentScript = sender.tab !== undefined && !fromExtensionPage;
  if (fromContentScript && !CONTENT_SCRIPT_ALLOWED.has(msgType)) return "refuse";
  return "allow";
}
