// Tests for the new-request start card renderer (Ask/Edit toggle, context
// block, mode-dependent how-it-works).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";
import { installDom, reset } from "./_dom-shim.mjs";

installDom();
const { renderStartCard } = await import(await bundle("src/sidepanel/start-card.ts"));

beforeEach(reset);

function baseView(over = {}) {
  return {
    container: document.createElement("div"),
    mode: "edit",
    canEdit: true,
    context: { title: "About — Test KB", path: "/about/", repoLabel: "o/r", selectionText: null },
    onPickAsk: () => {},
    onPickEdit: () => {},
    onDiscard: () => {},
    ...over,
  };
}

const modeButtons = (c) => c.querySelectorAll(".sc-mode");

test("renders both mode toggles with Edit active in edit mode", () => {
  const v = baseView({ mode: "edit" });
  renderStartCard(v);
  const btns = modeButtons(v.container);
  assert.equal(btns.length, 2);
  const edit = btns.find((b) => b.textContent.includes("Edit"));
  const ask = btns.find((b) => b.textContent.includes("Ask"));
  assert.ok(edit.className.includes("active"), "Edit is the active toggle");
  assert.ok(!ask.className.includes("active"), "Ask is not active");
});

test("edit mode shows the 3-step how-it-works", () => {
  const v = baseView({ mode: "edit" });
  renderStartCard(v);
  const steps = v.container.querySelectorAll(".sc-steps li");
  assert.equal(steps.length, 3);
  assert.match(v.container.textContent, /GitHub-backed change/i);
  assert.match(v.container.textContent, /manual edits/i);
});

test("ask mode shows the read-only note, not the steps", () => {
  const v = baseView({ mode: "ask" });
  renderStartCard(v);
  assert.equal(v.container.querySelectorAll(".sc-steps li").length, 0);
  assert.match(v.container.textContent, /Read-only/i);
  const ask = modeButtons(v.container).find((b) => b.textContent.includes("Ask"));
  assert.ok(ask.className.includes("active"));
});

test("Edit toggle is disabled when the repo is read-only", () => {
  const v = baseView({ canEdit: false });
  renderStartCard(v);
  const edit = modeButtons(v.container).find((b) => b.textContent.includes("Edit"));
  assert.equal(edit.disabled, true);
});

test("context block shows page, path, repo, and whole-page fallback", () => {
  const v = baseView({ context: { title: "About", path: "/about/", repoLabel: "o/r", selectionText: null } });
  renderStartCard(v);
  const text = v.container.textContent;
  assert.match(text, /About/);
  assert.match(text, /\/about\//);
  assert.match(text, /o\/r/);
  assert.match(text, /Whole page/i, "no selection -> whole-page context");
});

test("context block shows the selection when one is pinned", () => {
  const v = baseView({ context: { title: "About", path: "/about/", selectionText: "the intro line" } });
  renderStartCard(v);
  assert.match(v.container.textContent, /"the intro line"/);
});

test("the ✕ close button fires onDiscard", () => {
  let discarded = 0;
  const v = baseView({ onDiscard: () => { discarded++; } });
  renderStartCard(v);
  const close = v.container.querySelector(".sc-close");
  assert.ok(close, "renders a discard button");
  close.click();
  assert.equal(discarded, 1);
});

test("clicking a mode toggle fires its callback", () => {
  let asked = 0;
  const v = baseView({ mode: "edit", onPickAsk: () => { asked++; } });
  renderStartCard(v);
  const ask = modeButtons(v.container).find((b) => b.textContent.includes("Ask"));
  ask.click();
  assert.equal(asked, 1);
});

test("null context omits the context block but still renders toggles + steps", () => {
  const v = baseView({ context: null });
  renderStartCard(v);
  assert.equal(v.container.querySelectorAll(".sc-ctx").length, 0);
  assert.equal(modeButtons(v.container).length, 2);
  assert.equal(v.container.querySelectorAll(".sc-steps li").length, 3);
});
