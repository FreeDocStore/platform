// Tests for the shared pop-menu toggle (open/close, close hook, dismissal).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";
import { installDom, reset, fire, mount } from "./_dom-shim.mjs";

const dom = installDom();
const { wirePopToggle, closeAllPopMenus, setPopMenuCloseHook, initPopMenuDismissal } =
  await import(await bundle("src/sidepanel/pop-menu.ts"));

beforeEach(() => {
  reset();
  setPopMenuCloseHook(() => {}); // clear any hook a prior test installed
});

function wired(beforeOpen) {
  const btn = document.createElement("button");
  const menu = document.createElement("div");
  menu.className = "pop-menu";
  menu.hidden = true;
  mount(btn);
  mount(menu);
  wirePopToggle(btn, menu, beforeOpen);
  return { btn, menu };
}

test("clicking the trigger opens the menu; clicking again closes it", () => {
  const { btn, menu } = wired();
  fire(btn, "click");
  assert.equal(menu.hidden, false);
  fire(btn, "click");
  assert.equal(menu.hidden, true);
});

test("beforeOpen runs when opening", () => {
  let opened = 0;
  const { btn } = wired(() => { opened++; });
  fire(btn, "click"); // open
  assert.equal(opened, 1);
});

test("closeAllPopMenus hides every open menu and runs the close hook", () => {
  const { menu } = wired();
  menu.hidden = false;
  let hookRan = 0;
  setPopMenuCloseHook(() => { hookRan++; });
  closeAllPopMenus();
  assert.equal(menu.hidden, true);
  assert.equal(hookRan, 1);
});

test("opening one menu closes another already-open menu", () => {
  const a = wired();
  const b = wired();
  fire(a.btn, "click");
  assert.equal(a.menu.hidden, false);
  fire(b.btn, "click"); // opening b calls closeAllPopMenus first
  assert.equal(a.menu.hidden, true);
  assert.equal(b.menu.hidden, false);
});

test("a document click (outside) closes open menus once dismissal is wired", () => {
  initPopMenuDismissal();
  const { btn, menu } = wired();
  fire(btn, "click");
  assert.equal(menu.hidden, false);
  dom.fireDocument("click");
  assert.equal(menu.hidden, true);
});

test("the trigger click does not bubble to the document closer (stopPropagation)", () => {
  initPopMenuDismissal();
  const { btn, menu } = wired();
  // If the trigger click bubbled to document, the document closer would run
  // AFTER open and immediately hide the menu. It must stay open.
  fire(btn, "click");
  assert.equal(menu.hidden, false);
});
