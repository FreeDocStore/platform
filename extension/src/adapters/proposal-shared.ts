// Small pieces shared by the proposal builders/appliers: the nav config path,
// the on-page anchor derivation, and the history slimmer. Kept in one place so
// nav/edit/apply don't duplicate them.

import type { ChatMessage } from "../types";

export const NAV_PATH = "docs/nav.json";

// Derive a rendered-text anchor from an edit's markdown `find` string, for the
// in-page highlight when the user didn't select anything. Split on markdown
// delimiters (pipes, headings, emphasis, code, blockquote, list bullets,
// newlines) into contiguous text runs and return the longest - one table cell,
// one sentence, one list item - which is likely to appear verbatim inside a
// single rendered element. Undefined when nothing distinctive (>=8 chars).
export function anchorFromFind(find: string): string | undefined {
  const segments = find
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/^[ \t]*[-*+>#]+[ \t]+/gm, " ") // strip leading bullets/headings/quotes
    .split(/[|`*_~#>]+|\s{2,}|\r?\n/) // split on remaining md delimiters into runs
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 8);
  if (segments.length === 0) return undefined;
  segments.sort((a, b) => b.length - a.length);
  return segments[0].slice(0, 120);
}

export function toHistory(history: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return history
    .filter((m): m is ChatMessage & { role: "user" | "assistant" } =>
      m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
}
