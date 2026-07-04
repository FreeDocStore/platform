// Structured editing of a mkdocs.yml `nav:` block. This is the ONLY code that
// writes mkdocs.yml, and it only ever rewrites the nav section - the rest of
// the file is preserved byte-for-byte. edit_file/create_page stay docs/-locked
// (isValidReadPath), so the model cannot reach mkdocs.yml except through the
// update_nav_config tool, whose target file is chosen by the extension
// (resolveNavTarget), never by the model. That keeps the "hostile page steers a
// commit into config/CI" threat closed while allowing legit menu edits on
// generator-based (MkDocs/Material) sites.

import type { NavItem } from "../types";

/**
 * MkDocs nav paths are relative to docs_dir (docs/). Strip a leading "docs/"
 * if the model supplied a repo-relative href, so both forms serialize the same.
 */
export function toMkdocsPath(href: string): string {
  return href.replace(/^docs\//, "");
}

/**
 * Quote a nav label when it contains characters that would break the YAML
 * `- Label: path` mapping (a colon is the worst offender). Plain labels like
 * "Product Context" pass through unquoted.
 */
function yamlLabel(s: string): string {
  // Quote when the label holds a YAML-significant char (a colon is the worst
  // offender), the complex-key indicator `?`, leading/trailing whitespace, or
  // any control character. As the sole writer of mkdocs.yml, the quoted form
  // must fully escape backslash, quote AND control chars: an un-escaped newline
  // would end the `- Label: path` line early and inject a spurious sibling
  // top-level key, corrupting the config.
  const hasControl = (): boolean => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
  };
  if (!(s === "" || /[:#{}[\],&*!?|>'"%@`]/.test(s) || /^\s|\s$/.test(s) || hasControl())) {
    return s;
  }
  let esc = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === "\\") esc += "\\\\";
    else if (ch === '"') esc += '\\"';
    else if (c === 0x0a) esc += "\\n";
    else if (c === 0x0d) esc += "\\r";
    else if (c === 0x09) esc += "\\t";
    else if (c < 0x20 || c === 0x7f) esc += "\\x" + c.toString(16).padStart(2, "0");
    else esc += ch;
  }
  return `"${esc}"`;
}

/**
 * Serialize nav items into a mkdocs.yml `nav:` block (2-space indent per
 * level). Mirrors NavItem: a leaf (`label` + `href`) or a one-level dropdown
 * (`label` + `children`). Items with neither href nor children are dropped
 * (they'd be invalid). No trailing newline - the caller splices it in.
 */
export function serializeMkdocsNav(items: NavItem[]): string {
  const lines: string[] = ["nav:"];
  for (const it of items) {
    if (it.children && it.children.length > 0) {
      lines.push(`  - ${yamlLabel(it.label)}:`);
      for (const c of it.children) {
        lines.push(`      - ${yamlLabel(c.label)}: ${toMkdocsPath(c.href)}`);
      }
    } else if (it.href) {
      lines.push(`  - ${yamlLabel(it.label)}: ${toMkdocsPath(it.href)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Replace the top-level `nav:` block in a mkdocs.yml with a freshly-serialized
 * one, preserving every other line. The block runs from the `nav:` line through
 * all following blank/indented lines, up to the next top-level key (or EOF).
 * Blank separator lines before the next key are preserved.
 *
 * Returns null when there's no top-level `nav:` key - the caller decides
 * whether to append one (appending an explicit nav to a file that relied on
 * MkDocs' auto-nav changes behaviour, so that path requires a COMPLETE items
 * list, which update_nav_config already demands).
 */
export function replaceMkdocsNav(yaml: string, items: NavItem[]): string | null {
  const lines = yaml.split("\n");
  const navIdx = lines.findIndex((l) => /^nav\s*:/.test(l));
  if (navIdx === -1) return null;

  // Walk to the end of the block: consume blank and indented lines; stop at
  // the first non-indented, non-blank line (the next top-level key).
  let end = navIdx + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() === "" || /^\s/.test(l)) { end++; continue; }
    break;
  }
  // Don't swallow blank separators that sit between the block and the next
  // key - rewind over trailing blanks so they stay in `after`.
  let blockEnd = end;
  while (blockEnd > navIdx + 1 && lines[blockEnd - 1].trim() === "") blockEnd--;

  const before = lines.slice(0, navIdx);
  const after = lines.slice(blockEnd);
  const block = serializeMkdocsNav(items).split("\n");
  return [...before, ...block, ...after].join("\n");
}

/**
 * Produce the new mkdocs.yml content for a nav change: replace the existing
 * `nav:` block, or append one when the file had none.
 */
export function applyMkdocsNav(yaml: string, items: NavItem[]): string {
  const replaced = replaceMkdocsNav(yaml, items);
  if (replaced !== null) return replaced;
  // No nav: yet - append one, keeping exactly one trailing newline.
  const body = yaml.replace(/\s*$/, "");
  return `${body}\n\n${serializeMkdocsNav(items)}\n`;
}
