// Announces "the side panel is open in this window" to the service worker, so
// content scripts can gate their in-page affordances (✎ button, edit badge,
// highlight overlays) on the panel being open here. The SW learns the close via
// the port disconnecting when this document unloads.
//
// The connection is self-healing: an MV3 service worker can be recycled while
// the panel stays open, which drops the port. onDisconnect then reconnects and
// re-announces, so the SW's open-window set is restored on its next wake. If
// windows/connect are unavailable the announce is skipped (the in-page UI falls
// back to its prior always-visible behaviour).

/** Open the self-healing "sidepanel" port. Call once at boot. */
export function initPanelPresence(): void {
  void (async () => {
    let panelWindowId: number | undefined;
    try {
      panelWindowId = (await chrome.windows.getCurrent()).id;
    } catch {
      return; // no window id -> can't scope panel state; skip the announce
    }
    if (panelWindowId == null) return;
    // Set when THIS document is unloading (panel/window closing) so we don't
    // reconnect on the way out - that would race the SW's close broadcast and
    // briefly flash the in-page UI back on.
    let closing = false;
    window.addEventListener("pagehide", () => { closing = true; });
    const connect = (): void => {
      try {
        const port = chrome.runtime.connect({ name: "sidepanel" });
        port.postMessage({ windowId: panelWindowId });
        // A disconnect means the SW was recycled (not the panel closing - that
        // sets `closing` first); reconnect so the SW's open-window set is
        // restored on its next wake.
        port.onDisconnect.addListener(() => { if (!closing) connect(); });
      } catch {
        /* best-effort panel-state announce */
      }
    };
    connect();
  })();
}
