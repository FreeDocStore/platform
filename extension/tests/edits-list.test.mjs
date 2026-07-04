// Tests for the in-panel edits list renderer (pure: data in, DOM + callbacks).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";
import { installDom, reset, fire } from "./_dom-shim.mjs";

installDom();
const { renderEditsList } = await import(await bundle("src/sidepanel/edits-list.ts"));

beforeEach(reset);

function baseView(over = {}) {
  return {
    container: document.createElement("div"),
    repo: { owner: "acme", name: "docs" },
    tasks: [],
    orphanIds: [],
    fallbackLabel: (id) => `draft ${id.slice(0, 4)}`,
    onNewEdit: () => {},
    onOpenBoard: () => {},
    onSelectEdit: () => {},
    onArchive: () => {},
    ...over,
  };
}

test("empty state when no tasks and no drafts", () => {
  const v = baseView();
  renderEditsList(v);
  assert.equal(v.container.querySelectorAll(".edits-empty").length, 1);
  assert.equal(v.container.querySelectorAll(".edit-row").length, 0);
});

test("renders a row per task with title + status chip", () => {
  const v = baseView({
    tasks: [
      { id: "t1", title: "Fix typo", status: "proposed", sourcePath: "docs/a.md", selection: null },
      { id: "t2", title: "Add page", status: "in_review", sourcePath: "docs/b.md", selection: null },
    ],
  });
  renderEditsList(v);
  const rows = v.container.querySelectorAll(".edit-row");
  assert.equal(rows.length, 2);
  assert.equal(v.container.querySelectorAll(".edit-row-title")[0].textContent, "Fix typo");
  assert.ok(v.container.querySelectorAll(".edit-row-status")[0].textContent.length > 0);
});

test("clicking a row fires onSelectEdit with its taskId", () => {
  let picked = null;
  const v = baseView({
    tasks: [{ id: "t9", title: "Edit", status: "proposed", sourcePath: "docs/a.md", selection: null }],
    onSelectEdit: (id) => { picked = id; },
  });
  renderEditsList(v);
  fire(v.container.querySelector(".edit-row"), "click");
  assert.equal(picked, "t9");
});

test("archive button fires onArchive and stops propagation (no select)", () => {
  let archived = null, selected = false;
  const v = baseView({
    tasks: [{ id: "t9", title: "Edit", status: "proposed", sourcePath: "docs/a.md", selection: null }],
    onArchive: (id) => { archived = id; },
    onSelectEdit: () => { selected = true; },
  });
  renderEditsList(v);
  fire(v.container.querySelector(".edit-row-archive"), "click");
  assert.equal(archived, "t9");
  assert.equal(selected, false); // stopPropagation kept the row click from firing
});

test("header buttons fire onNewEdit and onOpenBoard(repoKey)", () => {
  let newed = false, board = null;
  const v = baseView({ onNewEdit: () => { newed = true; }, onOpenBoard: (k) => { board = k; } });
  renderEditsList(v);
  fire(v.container.querySelector(".edits-new"), "click");
  fire(v.container.querySelector(".edits-backlog"), "click");
  assert.equal(newed, true);
  assert.equal(board, "acme/docs");
});

test("orphan draft ids render with the fallback label and no archive button", () => {
  const v = baseView({ orphanIds: ["abcd1234"] });
  renderEditsList(v);
  const rows = v.container.querySelectorAll(".edit-row");
  assert.equal(rows.length, 1);
  assert.equal(v.container.querySelectorAll(".edit-row-title")[0].textContent, "draft abcd");
  assert.equal(v.container.querySelectorAll(".edit-row-archive").length, 0);
});
