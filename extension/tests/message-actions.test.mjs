import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";
import { installDom, reset, fire, mount } from "./_dom-shim.mjs";

installDom();
const { copyMarkdown, copyWithFeedback, messageAsMarkdown, renderDraftChip } = await import(await bundle("src/sidepanel/message-actions.ts"));

beforeEach(() => reset());

test("message Markdown preserves assistant formatting and quotes multiline user text", () => {
  assert.equal(messageAsMarkdown("assistant", "## Heading\n\n- item"), "### Assistant reply\n\n## Heading\n\n- item");
  assert.equal(messageAsMarkdown("user", "first\nsecond"), "### Your message\n\n> first\n> second");
});

test("copy reports unavailable, rejected and successful clipboard writes without throwing", async () => {
  assert.equal(await copyMarkdown("x", undefined), false);
  assert.equal(await copyMarkdown("x", { writeText: async () => { throw new Error("blocked"); } }), false);
  let copied = "";
  assert.equal(await copyMarkdown("useful markdown", { writeText: async (text) => { copied = text; } }), true);
  assert.equal(copied, "useful markdown");
});

test("message copy displays visible success and failure feedback", async () => {
  const feedback = document.createElement("span");
  assert.equal(await copyWithFeedback("markdown", { writeText: async () => {} }, feedback), true);
  assert.equal(feedback.textContent, "Copied");
  assert.equal(await copyWithFeedback("markdown", { writeText: async () => { throw new Error("denied"); } }, feedback), false);
  assert.match(feedback.textContent, /Copy failed/);
  assert.equal(await copyWithFeedback("markdown", undefined, feedback), false);
  assert.match(feedback.textContent, /Copy failed/);
});

test("attached draft chip renders full text and explicit removal hides it", () => {
  const chip = mount(document.createElement("div"));
  let removed = false;
  renderDraftChip(chip, "older complete reply draft", () => { removed = true; renderDraftChip(chip, null, () => {}); });
  assert.equal(chip.hidden, false);
  assert.match(chip.textContent, /older complete reply draft/);
  fire(chip.querySelector("button"), "click");
  assert.equal(removed, true);
  assert.equal(chip.hidden, true);
});
