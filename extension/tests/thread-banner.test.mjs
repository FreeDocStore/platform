// Tests for the edit-thread banner renderer (status pill, breadcrumb, ⋯ menu).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";
import { installDom, reset, fire } from "./_dom-shim.mjs";

installDom();
const { renderThreadBanner } = await import(await bundle("src/sidepanel/thread-banner.ts"));
const { statusLabelFor } = await import(await bundle("src/lib/task-format.ts"));

beforeEach(reset);

function baseView(over = {}) {
  return {
    container: document.createElement("div"),
    task: null,
    taskId: undefined,
    isDraft: false,
    applying: false,
    onOpenSection: () => {},
    onOpenPage: () => {},
    onSetStatus: () => {},
    onArchive: () => {},
    beforeMenuOpen: () => {},
    ...over,
  };
}

const task = (over = {}) => ({
  id: "t1",
  title: "Edit",
  status: "in_review",
  sourcePath: "docs/guide.md",
  selection: { text: "the intro sentence", heading: "Intro" },
  ...over,
});

function menuItems(container) {
  return container.querySelectorAll(".menu-item");
}

test("shows the status label and the page breadcrumb for a real task", () => {
  const v = baseView({ task: task(), taskId: "t1" });
  renderThreadBanner(v);
  assert.equal(v.container.hidden, false);
  assert.equal(v.container.querySelector(".t-badge").textContent, statusLabelFor("in_review"));
  const crumb = v.container.querySelector(".t-crumb").textContent;
  assert.match(crumb, /docs\/guide\.md/);
  assert.match(crumb, /Intro/);
});

test("shows 'Applying…' while an apply is in flight", () => {
  const v = baseView({ task: task(), taskId: "t1", applying: true });
  renderThreadBanner(v);
  assert.equal(v.container.querySelector(".t-badge").textContent, "Applying…");
});

test("draft thread (no task) shows a Draft badge", () => {
  const v = baseView({ task: null, taskId: "t1", isDraft: true });
  renderThreadBanner(v);
  assert.equal(v.container.querySelector(".t-badge").textContent, "Draft");
});

test("in_review task offers Mark done / Cancel / Archive in the ⋯ menu", () => {
  const v = baseView({ task: task({ status: "in_review" }), taskId: "t1" });
  renderThreadBanner(v);
  const labels = menuItems(v.container).map((b) => b.textContent);
  assert.ok(labels.some((l) => l.includes("Mark done")));
  assert.ok(labels.some((l) => l.includes("Cancel")));
  assert.ok(labels.some((l) => l.includes("Archive")));
});

test("clicking Archive in the menu fires onArchive with the taskId", () => {
  let archived = null;
  const v = baseView({ task: task(), taskId: "t1", onArchive: (id) => { archived = id; } });
  renderThreadBanner(v);
  const archive = menuItems(v.container).find((b) => b.textContent.includes("Archive"));
  fire(archive, "click");
  assert.equal(archived, "t1");
});

test("clicking Mark done fires onSetStatus(taskId, 'done')", () => {
  let call = null;
  const v = baseView({ task: task({ status: "in_review" }), taskId: "t1", onSetStatus: (id, s) => { call = [id, s]; } });
  renderThreadBanner(v);
  const done = menuItems(v.container).find((b) => b.textContent.includes("Mark done"));
  fire(done, "click");
  assert.deepEqual(call, ["t1", "done"]);
});

test("a done task offers Reopen (revive) rather than Mark done", () => {
  const v = baseView({ task: task({ status: "done" }), taskId: "t1" });
  renderThreadBanner(v);
  const labels = menuItems(v.container).map((b) => b.textContent);
  assert.ok(labels.some((l) => l.includes("Reopen")));
  assert.ok(!labels.some((l) => l.includes("Mark done")));
});
