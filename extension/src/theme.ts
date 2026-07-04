// Tiny DOM helper that applies appearance settings to the current page.
// Called from sidepanel.ts and options.ts on load, and re-applied when
// chrome.storage.onChanged fires so changes made in the options page show
// up in the sidepanel without a reload.
//
// - Theme: sets `data-theme="dark|light"` on <html>. CSS rules scoped to
//   `[data-theme="light"]` override the default dark palette.
// - Font size: sets a `--chat-font-size` custom property on <html>. Only
//   the chat body + prompt textarea consume it, so UI chrome stays stable.
// - Compact: toggles `data-compact="1"` on <html>. CSS scoped to
//   `[data-compact="1"]` tightens chat padding and gaps.

import type { Settings, Theme } from "./types";

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 48;
export const FONT_SIZE_DEFAULT = 13;

// Older installs stored "small" | "medium" | "large". Map those to the
// pixel values they used to resolve to so the first render after upgrade
// matches what the user had before.
const LEGACY_FONT_PX: Record<string, number> = {
  small: 12,
  medium: 13,
  large: 15,
};

export function resolveFontSize(value: unknown): number {
  // Treat null/undefined/empty-string as "no value" so users get the
  // default instead of the floor. Bare Number() coerces null and "" to
  // 0, which would otherwise clamp up to FONT_SIZE_MIN.
  if (value === null || value === undefined || value === "") {
    return FONT_SIZE_DEFAULT;
  }
  if (typeof value === "string" && value in LEGACY_FONT_PX) {
    return LEGACY_FONT_PX[value];
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

export function applyTheme(
  settings: Pick<Settings, "theme" | "fontSize" | "compact">,
): void {
  const theme: Theme = settings.theme ?? "dark";
  const fontSize = resolveFontSize(settings.fontSize);
  const html = document.documentElement;
  html.dataset.theme = theme;
  html.style.setProperty("--chat-font-size", `${fontSize}px`);
  if (settings.compact) {
    html.dataset.compact = "1";
  } else {
    delete html.dataset.compact;
  }
}
