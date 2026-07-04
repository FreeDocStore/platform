// Pure formatting / transform helpers extracted from sidepanel.ts.
//
// Everything here is a pure function: no DOM, no chrome.*, no module state, no
// import-time side effects. That's the whole point of the split - these are the
// only slices of the side panel that are unit-testable in `node --test` (the
// rest touches document/chrome at import and can't be imported in that harness).
// Keep this file pure so tests/sidepanel-format.test.mjs can import it directly.

import type { ChatMessage, PageContext, PendingProposal, Task } from "../types";
import { sourceToPublishedPath } from "../resolver";
// Task-status presentation lives in lib/task-format (shared with the board +
// kanban). Re-exported here so existing importers (sidepanel, format tests)
// keep their import site unchanged.
export { statusColor, statusLabelFor } from "../lib/task-format";

/**
 * The URL of the DEPLOYED page an edit produced - so "open page" / the
 * breadcrumb link land on the actual published page (e.g. /about/), not on
 * wherever the user happened to be when they made the edit (task.pageUrl, which
 * for a create-page or cross-page edit is a different page entirely).
 *
 * Combines the site origin (from task.pageUrl - always the docs site) with the
 * published path derived from the edited source file. Falls back to
 * task.pageUrl when the source can't be mapped, and returns null when there's
 * no URL to open at all.
 */
export function publishedUrlForTask(task: Pick<Task, "pageUrl" | "sourcePath"> | null): string | null {
  if (!task?.pageUrl) return null;
  const path = task.sourcePath ? sourceToPublishedPath(task.sourcePath) : null;
  if (!path) return task.pageUrl;
  try {
    return new URL(task.pageUrl).origin + path;
  } catch {
    return task.pageUrl;
  }
}

/** "HH:MM" in local time for a message timestamp. */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** True when two URLs are the same page ignoring the #fragment. */
export function sameUrlIgnoringHash(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    return false;
  }
}

/**
 * Strip heavy data out of a preview attachment before persisting. The full
 * PendingProposal lives in chrome.storage.session for the browser session;
 * chrome.storage.local would otherwise balloon by hundreds of KB per edit
 * (editedContent / newContent etc.). After a restart the proposal is gone
 * anyway, so previews serialize as preview_resolved/expired - the UI then
 * renders them without the Apply button (which would only return "expired").
 */
export function slimForPersist(msg: ChatMessage): ChatMessage {
  if (msg.attachment?.kind !== "preview") return msg;
  const data = msg.attachment.data as PendingProposal;
  return {
    ...msg,
    attachment: {
      kind: "preview_resolved",
      data: { proposalId: data.proposalId, outcome: "expired" },
    },
  };
}

/** Compact " · features: nav,search" suffix for the page-context line. */
export function renderFeaturesTag(features: PageContext["features"]): string {
  if (!features) return "";
  const on: string[] = [];
  if (features.nav) on.push("nav");
  if (features.search) on.push("search");
  if (features.changelog) on.push("log");
  if (features.sitemap) on.push("map");
  if (features.pageMeta) on.push("meta");
  if (features.references) on.push("refs");
  if (!on.length) return "";
  return ` · features: ${on.join(",")}`;
}

