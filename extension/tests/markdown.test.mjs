// Tests for the safe Markdown -> DOM renderer. A tiny DOM shim stands in
// for the browser so we can assert the produced node tree (and, critically,
// that non-http link schemes never become anchors).

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

// ── minimal DOM shim ─────────────────────────────────────────────────
function makeNode(tag) {
  return {
    tagName: tag ? tag.toUpperCase() : undefined,
    nodeType: tag ? 1 : 11,
    className: "",
    href: undefined,
    childNodes: [],
    appendChild(c) { this.childNodes.push(c); return c; },
    set textContent(v) { this.childNodes = [{ nodeType: 3, textValue: String(v) }]; },
    get textContent() { return collectText(this); },
  };
}
function collectText(node) {
  if (node.nodeType === 3) return node.textValue;
  return (node.childNodes || []).map(collectText).join("");
}
function findAll(node, tag, out = []) {
  for (const c of node.childNodes || []) {
    if (c.tagName === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}
globalThis.document = {
  createElement: (t) => makeNode(t),
  createTextNode: (v) => ({ nodeType: 3, textValue: String(v) }),
  createDocumentFragment: () => makeNode(null),
};

const { renderMarkdown, renderInline } = await import(await bundle("src/lib/markdown.ts"));

test("renders bold, italic, inline code", () => {
  const frag = renderMarkdown("This is **bold**, *em*, and `code`.");
  assert.equal(findAll(frag, "STRONG")[0].textContent, "bold");
  assert.equal(findAll(frag, "EM")[0].textContent, "em");
  assert.equal(findAll(frag, "CODE")[0].textContent, "code");
});

test("renders a table with header + body cells", () => {
  const md = [
    "| Bullet | Claim |",
    "|---|---|",
    "| **Product** | a mobile app |",
    "| Status | sample content |",
  ].join("\n");
  const frag = renderMarkdown(md);
  const tables = findAll(frag, "TABLE");
  assert.equal(tables.length, 1);
  assert.equal(findAll(frag, "TH").length, 2);
  const rows = findAll(frag, "TBODY")[0] ? findAll(findAll(frag, "TBODY")[0], "TR").length : 0;
  assert.equal(rows, 2);
  assert.equal(findAll(frag, "TD").length, 4);
});

test("renders fenced code blocks verbatim", () => {
  const frag = renderMarkdown("intro\n```\nconst x = 1;\n```\nafter");
  const pre = findAll(frag, "PRE");
  assert.equal(pre.length, 1);
  assert.match(pre[0].textContent, /const x = 1;/);
});

test("renders unordered + ordered lists", () => {
  const frag = renderMarkdown("- a\n- b\n\n1. one\n2. two");
  assert.equal(findAll(frag, "UL").length, 1);
  assert.equal(findAll(frag, "OL").length, 1);
  assert.equal(findAll(frag, "LI").length, 4);
});

test("http(s) links become anchors", () => {
  const nodes = renderInline("see [docs](https://example.com/x)");
  const a = nodes.find((n) => n.tagName === "A");
  assert.ok(a, "should produce an anchor");
  assert.equal(a.href, "https://example.com/x");
  assert.equal(a.textContent, "docs");
});

test("SECURITY: non-http link schemes never become anchors", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x"]) {
    const nodes = renderInline(`[click](${bad})`);
    assert.equal(nodes.find((n) => n.tagName === "A"), undefined, `${bad} must not be an anchor`);
    // Rendered as literal text instead.
    assert.match(nodes.map(collectText).join(""), /\[click\]/);
  }
});
