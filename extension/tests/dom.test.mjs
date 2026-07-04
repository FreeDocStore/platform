// Tests for the shared DOM helpers ($, $$, el). A tiny DOM shim stands in for
// the browser: el() needs document.createElement; $/$$ take an explicit `root`
// (ParentNode) so we assert they delegate to querySelector/querySelectorAll
// without a full document.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

// ── minimal DOM shim (createElement only) ────────────────────────────
function makeNode(tag) {
  return {
    tagName: tag ? tag.toUpperCase() : undefined,
    className: "",
    _text: null,
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
  };
}
globalThis.document = {
  createElement: (t) => makeNode(t),
};

const { $, $$, el } = await import(await bundle("src/lib/dom.ts"));

test("el: sets className and textContent", () => {
  const node = el("div", "card title", "Hello");
  assert.equal(node.tagName, "DIV");
  assert.equal(node.className, "card title");
  assert.equal(node.textContent, "Hello");
});

test("el: omits className and text when not given", () => {
  const node = el("span");
  assert.equal(node.tagName, "SPAN");
  assert.equal(node.className, "");
  assert.equal(node.textContent, null);
});

test("el: empty-string text is applied, but empty className is skipped", () => {
  const node = el("p", "", "");
  assert.equal(node.className, ""); // falsy className -> not assigned (stays default "")
  assert.equal(node.textContent, ""); // text != null -> assigned
});

test("$: delegates to root.querySelector and returns the node", () => {
  const found = { tagName: "BUTTON" };
  let calledWith = null;
  const root = { querySelector: (sel) => { calledWith = sel; return found; } };
  const node = $("#send-btn", root);
  assert.equal(calledWith, "#send-btn");
  assert.equal(node, found);
});

test("$$: returns querySelectorAll results as a real array", () => {
  const items = [{ tagName: "LI" }, { tagName: "LI" }];
  const root = { querySelectorAll: () => items };
  const out = $$(".item", root);
  assert.ok(Array.isArray(out));
  assert.deepEqual(out, items);
  // Array methods must work (the whole point of $$ over a NodeList).
  assert.equal(out.map((n) => n.tagName).join(","), "LI,LI");
});
