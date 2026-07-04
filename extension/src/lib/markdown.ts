// Minimal, SAFE Markdown -> DOM renderer for chat messages.
//
// Security: builds real DOM nodes via createElement + textContent only.
// There is NO innerHTML path, so model output can never inject markup or
// script (mirrors the XSS posture of the rest of the extension). Links are
// scheme-checked (http/https only); anything else renders as plain text.
//
// Scope: the subset that actually shows up in agent replies - headings,
// bold/italic/inline-code, fenced code blocks, links, ordered/unordered
// lists, blockquotes, tables, and horizontal rules. Not a spec-complete
// CommonMark parser; it degrades to readable text on anything it doesn't
// recognise.

import { isHttpUrl } from "./text";

// ── inline ───────────────────────────────────────────────────────────
// Order matters: inline code first (its content is literal), then bold,
// then italic, then links.
const INLINE_RE =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Render inline markdown in `text` as an array of DOM nodes. */
export function renderInline(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const code = document.createElement("code");
      code.textContent = m[1];
      out.push(code);
    } else if (m[2] !== undefined || m[3] !== undefined) {
      const b = document.createElement("strong");
      b.textContent = m[2] ?? m[3];
      out.push(b);
    } else if (m[4] !== undefined || m[5] !== undefined) {
      const em = document.createElement("em");
      em.textContent = m[4] ?? m[5];
      out.push(em);
    } else if (m[6] !== undefined && m[7] !== undefined) {
      const label = m[6];
      const url = m[7];
      if (isHttpUrl(url)) {
        const a = document.createElement("a");
        a.href = url;
        a.textContent = label;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "md-link";
        out.push(a);
      } else {
        out.push(document.createTextNode(`[${label}](${url})`));
      }
    }
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function appendInline(parent: HTMLElement, text: string): void {
  for (const n of renderInline(text)) parent.appendChild(n);
}

// ── tables ───────────────────────────────────────────────────────────
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

// ── block parser ─────────────────────────────────────────────────────

/** Parse `text` as markdown and return a fragment of block-level nodes. */
export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line: skip.
    if (trimmed === "") {
      i++;
      continue;
    }

    // Fenced code block.
    const fence = /^```(.*)$/.exec(trimmed);
    if (fence) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      const pre = document.createElement("pre");
      pre.className = "md-code";
      const code = document.createElement("code");
      code.textContent = buf.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    // Table: a header row followed by a separator row.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const headers = splitRow(line);
      i += 2; // header + separator
      const table = document.createElement("table");
      table.className = "md-table";
      const thead = document.createElement("thead");
      const htr = document.createElement("tr");
      for (const h of headers) {
        const th = document.createElement("th");
        appendInline(th, h);
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        const cells = splitRow(lines[i]);
        const tr = document.createElement("tr");
        for (let c = 0; c < headers.length; c++) {
          const td = document.createElement("td");
          appendInline(td, cells[c] ?? "");
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i++;
      }
      table.appendChild(tbody);
      frag.appendChild(table);
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const h = document.createElement(`h${heading[1].length}`);
      h.className = "md-h";
      appendInline(h, heading[2]);
      frag.appendChild(h);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      frag.appendChild(document.createElement("hr"));
      i++;
      continue;
    }

    // Blockquote (consecutive `>` lines).
    if (/^>\s?/.test(trimmed)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      const bq = document.createElement("blockquote");
      bq.className = "md-quote";
      appendInline(bq, buf.join(" "));
      frag.appendChild(bq);
      continue;
    }

    // Lists (ordered or unordered). A run of list items at this level.
    const listItem = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (listItem) {
      const ordered = /\d+\./.test(listItem[2]);
      const list = document.createElement(ordered ? "ol" : "ul");
      list.className = "md-list";
      while (i < lines.length) {
        const it = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!it) break;
        const li = document.createElement("li");
        appendInline(li, it[3]);
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    // Paragraph: gather consecutive non-blank lines that aren't another
    // block construct, joined with soft line breaks.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      const t = l.trim();
      if (
        t === "" ||
        /^```/.test(t) ||
        /^(#{1,6})\s+/.test(t) ||
        /^>\s?/.test(t) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(t) ||
        /^(\s*)([-*+]|\d+\.)\s+/.test(l) ||
        (l.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]))
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    const p = document.createElement("p");
    p.className = "md-p";
    para.forEach((l, idx) => {
      if (idx > 0) p.appendChild(document.createElement("br"));
      appendInline(p, l);
    });
    frag.appendChild(p);
  }

  return frag;
}
