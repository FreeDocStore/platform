// Content-script RPC + active-tab navigation helpers. Every function here
// talks to the active browsing tab (page context, selection, in-page edit
// focus, navigation) and holds NO panel state, so it lifts cleanly out of
// sidepanel.ts. Callers own the state that decides WHEN to call these.

import type { PageContext } from "../types";
import { getTask } from "../lib/tasks";
import { publishedUrlForTask, sameUrlIgnoringHash } from "./format";

export async function getActiveTabContext(): Promise<PageContext | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return null;
  const tabId = tab.id;

  const ask = async (): Promise<PageContext | null> => {
    const resp = (await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_CONTEXT" })) as {
      type: string;
      payload: PageContext | null;
    };
    return resp?.payload ?? null;
  };

  // Prefer messaging the content script that's already there (declared on
  // *.pages.dev via the manifest). Re-running executeScript on every call
  // does NOT dedupe against a declared content script - it re-executes the
  // bundle and stacks duplicate listeners in the page - so only inject as a
  // fallback when there's no receiver (tab opened before install, etc.).
  try {
    return await ask();
  } catch {
    // No receiver yet - fall through to a one-time injection.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch {
    // Some URLs (chrome://, chrome-extension://) reject injection.
    return null;
  }
  try {
    return await ask();
  } catch {
    return null; // content script unreachable after injection - give up quietly
  }
}

export async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

export async function querySelectionFromTab(): Promise<{ text: string; heading?: string } | null> {
  const id = await activeTabId();
  if (id == null) return null;
  try {
    const resp = (await chrome.tabs.sendMessage(id, { type: "GET_SELECTION" })) as {
      payload: { text: string; heading?: string } | null;
    };
    return resp?.payload ?? null;
  } catch {
    return null; // no content script on this tab (chrome://, etc.)
  }
}

export async function clearSelectionInTab(): Promise<void> {
  const id = await activeTabId();
  if (id == null) return;
  try {
    await chrome.tabs.sendMessage(id, { type: "CLEAR_SELECTION" });
  } catch {
    /* tab without a content script - nothing to clear */
  }
}

// Tell the active tab's content script to focus its in-page highlight on this
// edit thread's section (bright outline + scroll), or clear the focus (null).
// Best-effort: no content script (chrome://, not a docs page) just no-ops.
export async function focusEditInTab(taskId: string | null): Promise<void> {
  const id = await activeTabId();
  if (id == null) return;
  try {
    await chrome.tabs.sendMessage(id, { type: "FOCUS_EDIT", taskId });
  } catch {
    /* no content script on this tab */
  }
}

// Navigate the docked/active browsing tab to a URL in place (the side panel
// sits beside a normal tab; "open the page" should reuse it, not spawn tabs).
export async function navigateActiveTab(url: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  if (sameUrlIgnoringHash(tab.url, url)) return; // already there
  try {
    await chrome.tabs.update(tab.id, { url });
  } catch {
    /* tab gone / not updatable - ignore */
  }
}

// "Go to section": open the task's published page in the active tab (if we're
// not already there) and scroll its editable section into view. The content
// script re-injects on navigation, so after a URL change we poll FOCUS_EDIT
// until it answers (the script is up); its render then honours the armed
// scroll. Falls back to an in-place focus when the task has no page anchor.
export async function openEditSection(taskId: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const task = await getTask(taskId);
  // Navigate to the edited file's PUBLISHED page (e.g. /about/), not to
  // task.pageUrl - for a created or cross-page edit the latter is whatever page
  // the user was viewing when they made the change, not the page they edited.
  const url = publishedUrlForTask(task);
  if (!url) {
    void focusEditInTab(taskId);
    return;
  }
  if (sameUrlIgnoringHash(tab.url, url)) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "FOCUS_EDIT", taskId });
    } catch {
      /* content script not ready - a page-level nav isn't needed, ignore */
    }
    return;
  }
  await chrome.tabs.update(tab.id, { url });
  // Poll until the freshly-injected content script accepts the focus request.
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "FOCUS_EDIT", taskId });
      return;
    } catch {
      /* not up yet - keep polling (~6s budget) */
    }
  }
}
