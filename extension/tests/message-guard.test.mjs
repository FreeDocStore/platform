// Sender trust classification. The regression here: the options page and the
// board page are opened in TABS, so their messages carry a sender.tab - a bare
// `sender.tab !== undefined` check wrongly refused them as content scripts,
// silently dropping every SET_SETTINGS/GET_SETTINGS while the UI said "Saved."

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { classifyMessage } = await import(await bundle("src/background/message-guard.ts"));

const ID = "abcdefghijklmnop";
const extUrl = (page) => `chrome-extension://${ID}/${page}`;

test("options page (in a tab, extension origin) may SET_SETTINGS", () => {
  const sender = { id: ID, tab: { id: 7 }, url: extUrl("options.html") };
  assert.equal(classifyMessage("SET_SETTINGS", sender, ID), "allow");
  assert.equal(classifyMessage("GET_SETTINGS", sender, ID), "allow");
});

test("board page (in a tab, extension origin) is allowed too", () => {
  const sender = { id: ID, tab: { id: 9 }, url: extUrl("board.html") };
  assert.equal(classifyMessage("SET_TASK_STATUS", sender, ID), "allow");
});

test("side panel (no tab) is allowed", () => {
  const sender = { id: ID, url: extUrl("sidepanel.html") };
  assert.equal(classifyMessage("CHAT_TURN", sender, ID), "allow");
});

test("real content script (tab + web-page url) is refused for privileged types", () => {
  const sender = { id: ID, tab: { id: 3 }, url: "https://foo.pages.dev/docs/" };
  assert.equal(classifyMessage("SET_SETTINGS", sender, ID), "refuse");
  assert.equal(classifyMessage("CHAT_TURN", sender, ID), "refuse");
});

test("content script MAY send its allowlisted types", () => {
  const sender = { id: ID, tab: { id: 3 }, url: "https://foo.pages.dev/docs/" };
  assert.equal(classifyMessage("READ_REPO_FILE", sender, ID), "allow");
  assert.equal(classifyMessage("SELECTION_RESULT", sender, ID), "allow");
  assert.equal(classifyMessage("OPEN_BOARD", sender, ID), "allow");
  // IS_PANEL_OPEN gates in-page UI on panel visibility; read-only, so a content
  // script is allowed to ask it (refusing it would leave the in-page affordances
  // permanently hidden).
  assert.equal(classifyMessage("IS_PANEL_OPEN", sender, ID), "allow");
});

test("another extension's message is dropped", () => {
  const sender = { id: "someOtherExtId", tab: { id: 3 }, url: "https://evil.example/" };
  assert.equal(classifyMessage("SET_SETTINGS", sender, ID), "drop");
});

test("a page can't spoof the extension origin to escalate (id must match too)", () => {
  // A content script claiming a chrome-extension URL but with the wrong id is
  // still dropped at the id gate; and our-id + web url is still a content script.
  const spoofUrl = { id: "otherExt", tab: { id: 3 }, url: extUrl("options.html") };
  assert.equal(classifyMessage("SET_SETTINGS", spoofUrl, ID), "drop");
});
