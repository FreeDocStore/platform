// GitHub avatar helpers, shared by the board and the side panel.
//
// github.com/<login>.png is a stable redirect to a user's avatar - no API call
// and no numeric user id needed, so we can render an avatar from just a login.
// The element is fully self-contained (inline styles + a graceful initial-letter
// fallback) so it drops into either surface without CSS coordination.

/** Avatar image URL for a GitHub login. `size` is the requested pixel size. */
export function avatarUrl(login: string, size = 40): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=${size}`;
}

// Deterministic muted background for the fallback chip, so a given person keeps
// a stable colour. Small fixed palette (matches the dark theme).
const FALLBACK_BG = ["#2a3f5f", "#3f2a5f", "#2a5f4f", "#5f3f2a", "#5f2a3f", "#3f5f2a"];
function fallbackColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return FALLBACK_BG[h % FALLBACK_BG.length];
}

function setChip(span: HTMLElement, size: number, login: string | null | undefined): void {
  const letter = login ? login.replace(/^@/, "")[0]?.toUpperCase() ?? "?" : "?";
  span.textContent = letter;
  span.style.background = login ? fallbackColor(login) : "#3a3f4a";
  span.style.color = "#fff";
  span.style.fontSize = `${Math.round(size * 0.55)}px`;
  span.style.fontWeight = "600";
}

/**
 * A round avatar element for `login` (e.g. "octocat"). Falls back to a coloured
 * initial-letter chip when the login is missing or the image fails to load
 * (deleted account, offline). `size` is the rendered diameter in px.
 */
export function avatarEl(login: string | null | undefined, size = 18): HTMLElement {
  const span = document.createElement("span");
  span.className = "gd-avatar";
  span.title = login ? `@${login.replace(/^@/, "")}` : "unknown";
  span.style.cssText = [
    `width:${size}px`, `height:${size}px`, "border-radius:50%",
    "display:inline-flex", "align-items:center", "justify-content:center",
    "overflow:hidden", "flex:0 0 auto", "vertical-align:middle", "line-height:1",
  ].join(";");
  if (!login) {
    setChip(span, size, null);
    return span;
  }
  const clean = login.replace(/^@/, "");
  const img = document.createElement("img");
  img.src = avatarUrl(clean, size * 2); // 2x for retina
  img.alt = `@${clean}`;
  img.width = size;
  img.height = size;
  img.style.cssText = `width:${size}px;height:${size}px;object-fit:cover;display:block`;
  // Broken avatar (deleted user / offline): swap in the initial-letter chip.
  img.addEventListener("error", () => setChip(span, size, clean));
  span.appendChild(img);
  return span;
}
