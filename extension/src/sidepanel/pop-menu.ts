// Popup-menu toggle shared by the header "⋯" (static) and the banner "⋯"
// (rebuilt each render). A single document-level click closes every open
// .pop-menu, so dynamically created menus need no registry. Extracted from
// sidepanel.ts; the two side-panel-specific behaviours (disarm the two-click
// "clear chat" on close, close the thread dropdown on open) are injected so
// this module stays DOM-only.

let onCloseHook: (() => void) | null = null;

/** Register a side-effect to run whenever all pop-menus close (e.g. disarm the
 *  two-click "clear chat" so a stale armed state can't cause a one-click wipe). */
export function setPopMenuCloseHook(fn: () => void): void {
  onCloseHook = fn;
}

export function closeAllPopMenus(): void {
  document.querySelectorAll<HTMLElement>(".pop-menu").forEach((m) => { m.hidden = true; });
  onCloseHook?.();
}

// Position an opening menu with viewport-fixed coords instead of relying on
// absolute-in-.pop-wrap. The side panel is narrow and several ancestors set
// overflow/clip, so an absolutely-positioned menu near the right edge spilled
// off-panel and was invisible. Fixed + right-anchored to the trigger, clamped
// to the viewport, guarantees it lands on-screen and above everything.
function positionPopMenu(btn: HTMLElement, menu: HTMLElement): void {
  const r = btn.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  menu.style.left = "auto";
  // Anchor the menu's right edge under the trigger's right edge; never let it
  // touch either viewport edge (min 4px right inset).
  menu.style.right = `${Math.round(Math.max(4, window.innerWidth - r.right))}px`;
  // Cap height to the space below the trigger so a long menu scrolls instead
  // of running off the bottom of the panel.
  menu.style.maxHeight = `${Math.max(80, Math.round(window.innerHeight - r.bottom - 12))}px`;
  menu.style.overflowY = "auto";
}

/** Wire a trigger button to toggle its menu. `beforeOpen` runs just before the
 *  menu opens (e.g. close the thread dropdown so they don't overlap). Item
 *  clicks bubble to document (closing all menus) after their own handler runs,
 *  so a menu item both acts and dismisses. */
export function wirePopToggle(btn: HTMLElement, menu: HTMLElement, beforeOpen?: () => void): void {
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let this same click reach the document closer
    const willOpen = menu.hidden;
    closeAllPopMenus();
    beforeOpen?.();
    if (willOpen) {
      positionPopMenu(btn, menu);
      menu.hidden = false;
    }
  });
}

/** Register the global listeners that dismiss open pop-menus on an outside
 *  click, a scroll inside the panel, or a resize (a fixed menu doesn't track
 *  the page). Call once at startup. */
export function initPopMenuDismissal(): void {
  document.addEventListener("click", () => closeAllPopMenus());
  window.addEventListener("resize", () => closeAllPopMenus());
  document.addEventListener("scroll", () => closeAllPopMenus(), true);
}
