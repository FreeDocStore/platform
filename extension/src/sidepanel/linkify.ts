// Turn bare URLs in plain text into clickable anchors. Used for user
// messages and resolved-preview replies (assistant Markdown is rendered
// separately via lib/markdown). Kept UI-agnostic: it only touches the DOM
// node it's handed plus chrome.tabs for the non-navigable schemes.

/**
 * Walk a string, splitting at URLs, and append a mix of text and anchor
 * nodes to `parent`. http(s) anchors open in a new tab via `target`.
 * chrome:// and chrome-extension:// URLs can't be navigated by a
 * normal anchor (Chrome blocks the navigation), so we intercept the
 * click and open them via chrome.tabs.create instead.
 */
const URL_RE = /\b(?:https?:\/\/|chrome:\/\/|chrome-extension:\/\/)[^\s<>"')]+/g;

export function appendLinkified(parent: HTMLElement, text: string): void {
  URL_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const start = m.index;
    const url = m[0];
    if (start > last) parent.appendChild(document.createTextNode(text.slice(last, start)));
    const a = document.createElement("a");
    a.href = url;
    a.textContent = url;
    a.className = "chat-link";
    if (url.startsWith("http")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    } else {
      // chrome:// or chrome-extension:// - normal anchor click is blocked.
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void chrome.tabs.create({ url });
      });
    }
    parent.appendChild(a);
    last = start + url.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
