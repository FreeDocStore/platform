// Open (or focus) the tasks board tab, optionally deep-linked to a repo.
// Self-contained: only touches chrome.tabs/runtime, no panel state - so it
// lives outside sidepanel.ts. Reuses an existing board tab (found by URL
// prefix) instead of piling up duplicates on every click.

export async function openBoard(repo?: string): Promise<void> {
  const base = chrome.runtime.getURL("board.html");
  const url = repo ? `${base}?repo=${encodeURIComponent(repo)}` : base;
  try {
    const tabs = await chrome.tabs.query({ url: `${base}*` });
    const found = tabs.find((t) => t.id != null && t.url?.startsWith(base));
    if (found?.id != null) {
      await chrome.tabs.update(found.id, { active: true, url });
      return;
    }
  } catch {
    // No url-filter permission - just open a new board tab.
  }
  await chrome.tabs.create({ url });
}
