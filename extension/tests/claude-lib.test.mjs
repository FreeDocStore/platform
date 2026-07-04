// Tests for the Anthropic multi-turn tool loop (lib/claude.ts).
// Mocks fetch to api.anthropic.com and asserts the loop: plain replies,
// read-tool round-trips (tool_use -> tool_result -> finish), terminal
// write tools, terminal priority, and the OpenAI->Anthropic tool-schema
// conversion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { callClaudeMultiTurn } = await import(await bundle("src/lib/claude.ts"));

// Queue of Anthropic message responses; each fetch returns the next one
// (or repeats the last). Captures request bodies for assertions.
function installMock(responses) {
  const calls = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const BASE = {
  apiKey: "sk-ant-test",
  model: "claude-sonnet-4-6",
  mode: "read",
  sourcePath: "docs/index.html",
  fileContent: "Hello world",
  userPrompt: "what is here?",
  dispatch: async () => "{}",
};

test("plain reply when the model emits no tool_use", async () => {
  const { restore } = installMock([{ content: [{ type: "text", text: "It says hello." }], stop_reason: "end_turn" }]);
  try {
    const r = await callClaudeMultiTurn({ ...BASE });
    assert.deepEqual(r, { kind: "plain", content: "It says hello." });
  } finally { restore(); }
});

test("converts OpenAI tool schemas to Anthropic shape (input_schema, not parameters)", async () => {
  const { calls, restore } = installMock([{ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }]);
  try {
    await callClaudeMultiTurn({ ...BASE });
    const tools = calls[0].body.tools;
    assert.ok(Array.isArray(tools) && tools.length > 0);
    for (const t of tools) {
      assert.ok(t.name && t.description && t.input_schema, "each tool needs name/description/input_schema");
      assert.equal(t.parameters, undefined, "OpenAI 'parameters' key must be gone");
      assert.equal(t.function, undefined, "OpenAI 'function' wrapper must be gone");
    }
    // read mode exposes the read tools + clarification, no write tools.
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("read_page") && names.includes("ask_clarification"));
    assert.ok(!names.includes("edit_file"), "read mode must not expose edit_file");
    // sends required Anthropic headers.
    assert.equal(calls[0].headers["x-api-key"], "sk-ant-test");
    assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  } finally { restore(); }
});

test("read tool round-trips: dispatch result feeds back, then a plain answer", async () => {
  const dispatched = [];
  const { calls, restore } = installMock([
    { content: [{ type: "tool_use", id: "tu_1", name: "list_pages", input: {} }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "There are 3 pages." }], stop_reason: "end_turn" },
  ]);
  try {
    const r = await callClaudeMultiTurn({
      ...BASE,
      dispatch: async (call) => { dispatched.push(call); return JSON.stringify({ pages: 3 }); },
    });
    assert.deepEqual(r, { kind: "plain", content: "There are 3 pages." });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].name, "list_pages");
    // Second request must carry the assistant tool_use turn + a user
    // tool_result block referencing the same id.
    const secondMsgs = calls[1].body.messages;
    const toolResultMsg = secondMsgs.find((m) =>
      Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "tu_1"));
    assert.ok(toolResultMsg, "tool_result for tu_1 must be sent back");
  } finally { restore(); }
});

test("terminal edit_file returns an edit proposal", async () => {
  const { restore } = installMock([{
    content: [{ type: "tool_use", id: "tu_e", name: "edit_file", input: {
      edits: [{ find: "Hello", replace: "Hi" }], summary: "greeting",
    } }],
    stop_reason: "tool_use",
  }]);
  try {
    const r = await callClaudeMultiTurn({ ...BASE, mode: "edit" });
    assert.equal(r.kind, "edit");
    assert.equal(r.proposal.summary, "greeting");
    assert.deepEqual(r.proposal.edits, [{ find: "Hello", replace: "Hi" }]);
  } finally { restore(); }
});

test("clarification wins over a same-turn edit (terminal priority)", async () => {
  const { restore } = installMock([{
    content: [
      { type: "tool_use", id: "a", name: "edit_file", input: { edits: [{ find: "x", replace: "y" }], summary: "s" } },
      { type: "tool_use", id: "b", name: "ask_clarification", input: { question: "Which heading?" } },
    ],
    stop_reason: "tool_use",
  }]);
  try {
    const r = await callClaudeMultiTurn({ ...BASE, mode: "edit" });
    assert.equal(r.kind, "clarification");
    assert.equal(r.clarification.question, "Which heading?");
  } finally { restore(); }
});

test("gives up cleanly after MAX_TURNS of tool calls", async () => {
  // Always return a tool_use so the loop never terminates on its own.
  const { restore } = installMock([
    { content: [{ type: "tool_use", id: "loop", name: "list_pages", input: {} }], stop_reason: "tool_use" },
  ]);
  try {
    const r = await callClaudeMultiTurn({ ...BASE, dispatch: async () => "{}" });
    assert.equal(r.kind, "plain");
    assert.match(r.content, /exceeded 8 turns/);
  } finally { restore(); }
});
