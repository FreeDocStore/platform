// callOpenAIMultiTurn tests. Mocks fetch to avoid real API calls.
//
// The fetch mock is keyed by hostname so the OpenAI queue and any
// GitHub queue we add are independent and readable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { callOpenAIMultiTurn, MAX_TURNS } = await import(
  await bundle("src/lib/openai.ts")
);

/**
 * Install a fetch mock keyed by hostname prefix.
 * `queues` is a map of { 'api.openai.com': [response, ...], ... }.
 * Each entry is popped FIFO as matching requests come in.
 */
function installFetchMock(queues) {
  const calls = [];
  const working = Object.fromEntries(
    Object.entries(queues).map(([k, v]) => [k, [...v]]),
  );
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    const host = new URL(u).hostname;
    for (const [prefix, queue] of Object.entries(working)) {
      if (host === prefix || host.endsWith("." + prefix)) {
        const next = queue.shift();
        if (!next) throw new Error(`No mock response left for ${host}`);
        const body =
          typeof next.body === "string" ? next.body : JSON.stringify(next.body);
        return new Response(body, {
          status: next.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error(`No mock queue matches host ${host} (${u})`);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function openaiMessage({ content = null, tool_calls }) {
  return { body: { choices: [{ message: { content, tool_calls } }] } };
}

function openaiEditFileTurn(args, id = "call_1") {
  return openaiMessage({
    tool_calls: [
      { id, type: "function", function: { name: "edit_file", arguments: JSON.stringify(args) } },
    ],
  });
}

function openaiClarifyTurn(args, id = "call_1") {
  return openaiMessage({
    tool_calls: [
      { id, type: "function", function: { name: "ask_clarification", arguments: JSON.stringify(args) } },
    ],
  });
}

function openaiNavTurn(args, id = "call_1") {
  return openaiMessage({
    tool_calls: [
      { id, type: "function", function: { name: "update_nav_config", arguments: JSON.stringify(args) } },
    ],
  });
}

function openaiListPagesTurn(id = "call_1") {
  return openaiMessage({
    tool_calls: [
      { id, type: "function", function: { name: "list_pages", arguments: "{}" } },
    ],
  });
}

function openaiReadPageTurn(path, id = "call_1") {
  return openaiMessage({
    tool_calls: [
      { id, type: "function", function: { name: "read_page", arguments: JSON.stringify({ path }) } },
    ],
  });
}

function openaiPlainTurn(content) {
  return openaiMessage({ content, tool_calls: undefined });
}

const BASE_ARGS = {
  apiKey: "sk-test",
  model: "gpt-5.4",
  mode: "edit",
  sourcePath: "docs/architecture.html",
  fileContent: "<html><body><h1>Architecture</h1></body></html>",
  userPrompt: "add a dark-theme note",
  dispatch: async () => {
    throw new Error("dispatch not expected in this test");
  },
};

// ── Terminal tool shapes ─────────────────────────────────────────────

test("callOpenAIMultiTurn: edit_file tool call -> EditResult", async () => {
  const toolArgs = {
    edits: [{ find: "<h1>Architecture</h1>", replace: "<h1>Architecture (dark theme)</h1>" }],
    summary: "Note dark theme choice",
    rationale: "Minor wording change",
  };
  const { calls, restore } = installFetchMock({
    "api.openai.com": [openaiEditFileTurn(toolArgs)],
  });
  try {
    const result = await callOpenAIMultiTurn(BASE_ARGS);
    assert.equal(result.kind, "edit");
    assert.equal(result.proposal.summary, "Note dark theme choice");
    assert.equal(result.proposal.edits.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.model, "gpt-5.4");
    assert.equal(sent.tool_choice, "auto");
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: plain content (no tool_calls) -> PlainReply", async () => {
  const { restore } = installFetchMock({
    "api.openai.com": [openaiPlainTurn("I need more context about which section to edit.")],
  });
  try {
    const r = await callOpenAIMultiTurn(BASE_ARGS);
    assert.equal(r.kind, "plain");
    assert.match(r.content, /more context/i);
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: API error surfaces clearly", async () => {
  const { restore } = installFetchMock({
    "api.openai.com": [{ status: 401, body: { error: { message: "Invalid API key" } } }],
  });
  try {
    await assert.rejects(() => callOpenAIMultiTurn(BASE_ARGS), /OpenAI 401/);
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: unparseable tool arguments throw", async () => {
  const { restore } = installFetchMock({
    "api.openai.com": [
      openaiMessage({
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "edit_file", arguments: "not-json" } },
        ],
      }),
    ],
  });
  try {
    await assert.rejects(() => callOpenAIMultiTurn(BASE_ARGS), /unparseable/i);
  } finally {
    restore();
  }
});

// ── Tool offering ────────────────────────────────────────────────────

test("callOpenAIMultiTurn: edit mode without nav still OFFERS update_nav_config (for MkDocs) but adds no addendum", async () => {
  const { calls, restore } = installFetchMock({
    "api.openai.com": [openaiEditFileTurn({ edits: [{ find: "<h1>Architecture</h1>", replace: "<h1>X</h1>" }], summary: "x" })],
  });
  try {
    await callOpenAIMultiTurn(BASE_ARGS);
    const sent = JSON.parse(calls[0].init.body);
    const toolNames = sent.tools.map((t) => t.function.name).sort();
    // update_nav_config is offered in ALL edit modes now: on MkDocs sites the
    // nav lives in mkdocs.yml (no navConfig in context) and it's the only
    // tool that can reach it.
    assert.deepEqual(
      toolNames,
      ["ask_clarification", "create_page", "edit_file", "list_pages", "list_repo_files", "read_page", "read_repo_file", "remember", "update_nav_config"],
    );
    assert.equal(sent.tool_choice, "auto");
    // But no nav ADDENDUM / injected nav.json when navConfig is absent.
    assert.equal(sent.messages[0].content.includes("docs/nav.json"), false);
  } finally {
    restore();
  }
});

const NAV_ARGS = {
  ...BASE_ARGS,
  navConfig: {
    items: [
      { href: "components.html", label: "Components" },
      { href: "content.html", label: "Content" },
    ],
    navSkip: ["index.html"],
    raw: JSON.stringify(
      {
        items: [
          { href: "components.html", label: "Components" },
          { href: "content.html", label: "Content" },
        ],
        navSkip: ["index.html"],
      },
      null,
      2,
    ),
  },
};

test("callOpenAIMultiTurn: edit mode with nav offers update_nav_config too", async () => {
  const { calls, restore } = installFetchMock({
    "api.openai.com": [openaiEditFileTurn({ edits: [{ find: "<h1>Architecture</h1>", replace: "<h1>X</h1>" }], summary: "x" })],
  });
  try {
    await callOpenAIMultiTurn(NAV_ARGS);
    const sent = JSON.parse(calls[0].init.body);
    const toolNames = sent.tools.map((t) => t.function.name).sort();
    assert.deepEqual(
      toolNames,
      ["ask_clarification", "create_page", "edit_file", "list_pages", "list_repo_files", "read_page", "read_repo_file", "remember", "update_nav_config"],
    );
    assert.equal(sent.tool_choice, "auto");
    assert.match(sent.messages[0].content, /docs\/nav\.json/);
    assert.match(sent.messages[0].content, /update_nav_config/);
    assert.match(sent.messages[sent.messages.length - 1].content, /Site nav config/);
    assert.match(sent.messages[sent.messages.length - 1].content, /"components\.html"/);
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: read mode omits edit_file and update_nav_config", async () => {
  const { calls, restore } = installFetchMock({
    "api.openai.com": [openaiPlainTurn("Some answer.")],
  });
  try {
    await callOpenAIMultiTurn({
      ...BASE_ARGS,
      mode: "read",
      fileContent: "Visible text",
      pageTitle: "Architecture",
    });
    const sent = JSON.parse(calls[0].init.body);
    const toolNames = sent.tools.map((t) => t.function.name).sort();
    assert.deepEqual(
      toolNames,
      ["ask_clarification", "list_pages", "list_repo_files", "read_page", "read_repo_file"],
    );
    assert.equal(sent.tool_choice, "auto");
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: update_nav_config tool call -> NavResult", async () => {
  const navArgs = {
    items: [
      { href: "content.html", label: "Content" },
      { href: "components.html", label: "Components" },
    ],
    navSkip: ["index.html"],
    summary: "Swap Content ahead of Components",
  };
  const { restore } = installFetchMock({
    "api.openai.com": [openaiNavTurn(navArgs)],
  });
  try {
    const r = await callOpenAIMultiTurn(NAV_ARGS);
    assert.equal(r.kind, "nav");
    assert.equal(r.proposal.items.length, 2);
    assert.equal(r.proposal.items[0].href, "content.html");
    assert.deepEqual(r.proposal.navSkip, ["index.html"]);
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: ask_clarification tool call -> ClarificationResult", async () => {
  const clarifyArgs = {
    question: "Which heading do you want updated - the page title or the first section?",
    why: "Prompt 'fix the title' is ambiguous between <title> and <h1>.",
  };
  const { restore } = installFetchMock({
    "api.openai.com": [openaiClarifyTurn(clarifyArgs)],
  });
  try {
    const r = await callOpenAIMultiTurn(BASE_ARGS);
    assert.equal(r.kind, "clarification");
    assert.match(r.clarification.question, /heading/i);
    assert.match(r.clarification.why, /ambiguous/i);
  } finally {
    restore();
  }
});

// ── Multi-turn integration ───────────────────────────────────────────

test("callOpenAIMultiTurn: list_pages -> plain reply (2 OpenAI calls)", async () => {
  const { calls, restore } = installFetchMock({
    "api.openai.com": [
      openaiListPagesTurn("call_a"),
      openaiPlainTurn("The site has 4 pages."),
    ],
  });
  const dispatched = [];
  try {
    const r = await callOpenAIMultiTurn({
      ...BASE_ARGS,
      dispatch: async (call) => {
        dispatched.push(call.name);
        return JSON.stringify({ site: "x", currentPage: "docs/index.html", navItems: [], otherPages: [] });
      },
    });
    assert.equal(r.kind, "plain");
    assert.match(r.content, /4 pages/);
    // Two OpenAI round-trips: initial tool call + follow-up plain reply.
    assert.equal(calls.filter((c) => c.url.includes("openai.com")).length, 2);
    assert.deepEqual(dispatched, ["list_pages"]);
    // The second request must carry the assistant tool_calls + the
    // tool-role result message so OpenAI has the dispatch output.
    const secondBody = JSON.parse(calls[1].init.body);
    const roles = secondBody.messages.map((m) => m.role);
    assert.ok(roles.includes("tool"), "second call must include a tool-role message");
    assert.ok(roles.includes("assistant"), "second call must include the assistant tool_calls message");
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: list_pages -> read_page -> read_page -> plain (4 calls)", async () => {
  const { calls, restore } = installFetchMock({
    "api.openai.com": [
      openaiListPagesTurn("c1"),
      openaiReadPageTurn("docs/components.html", "c2"),
      openaiReadPageTurn("docs/content.html", "c3"),
      openaiPlainTurn("Nav is mentioned in components.html and content.html."),
    ],
  });
  const dispatched = [];
  try {
    const r = await callOpenAIMultiTurn({
      ...BASE_ARGS,
      dispatch: async (call) => {
        dispatched.push(call.name);
        if (call.name === "list_pages") {
          return JSON.stringify({
            site: "x",
            currentPage: "docs/index.html",
            navItems: [],
            otherPages: ["docs/components.html", "docs/content.html"],
          });
        }
        return JSON.stringify({
          path: call.args.path,
          title: "T",
          text: "stub",
          truncated: false,
        });
      },
    });
    assert.equal(r.kind, "plain");
    assert.match(r.content, /components\.html/);
    assert.equal(calls.filter((c) => c.url.includes("openai.com")).length, 4);
    assert.deepEqual(dispatched, ["list_pages", "read_page", "read_page"]);
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: 8-turn cap returns synthetic overflow message", async () => {
  // Queue 8 list_pages turns - the loop hits MAX_TURNS and returns the
  // overflow string without dispatching a ninth.
  const openaiQueue = [];
  for (let i = 0; i < MAX_TURNS; i++) {
    openaiQueue.push(openaiReadPageTurn(`docs/p${i}.html`, `c${i}`));
  }
  const { calls, restore } = installFetchMock({ "api.openai.com": openaiQueue });
  try {
    const r = await callOpenAIMultiTurn({
      ...BASE_ARGS,
      dispatch: async () =>
        JSON.stringify({ path: "docs/p.html", title: "T", text: "x", truncated: false }),
    });
    assert.equal(r.kind, "plain");
    assert.match(r.content, /exceeded 8 turns/i);
    assert.equal(calls.filter((c) => c.url.includes("openai.com")).length, MAX_TURNS);
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: write is terminal (edit_file beats further tool calls)", async () => {
  // read_page then edit_file. Second turn must terminate the loop; the
  // model shouldn't get a third round-trip.
  const editArgs = {
    edits: [{ find: "<h1>Architecture</h1>", replace: "<h1>Arch</h1>" }],
    summary: "Shorten title",
  };
  const { calls, restore } = installFetchMock({
    "api.openai.com": [
      openaiReadPageTurn("docs/components.html", "c1"),
      openaiEditFileTurn(editArgs, "c2"),
      openaiPlainTurn("SHOULD NOT REACH"),
    ],
  });
  try {
    const r = await callOpenAIMultiTurn({
      ...BASE_ARGS,
      dispatch: async () => JSON.stringify({ path: "docs/components.html", title: "C", text: "x", truncated: false }),
    });
    assert.equal(r.kind, "edit");
    assert.equal(r.proposal.summary, "Shorten title");
    // Exactly two OpenAI calls - the third queued response is unreached.
    assert.equal(calls.filter((c) => c.url.includes("openai.com")).length, 2);
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: clarification wins over edit in same-turn tool_calls (regression)", async () => {
  // Regression: the old implementation iterated toolCalls in array order
  // and returned the first terminal match. A model emitting
  // [edit_file, ask_clarification] in one message would commit the edit
  // instead of asking. Priority must be clarification > edit > nav,
  // regardless of array position.
  const mixed = openaiMessage({
    tool_calls: [
      { id: "c1", type: "function", function: { name: "edit_file", arguments: JSON.stringify({
        edits: [{ find: "<h1>X</h1>", replace: "<h1>Y</h1>" }],
        summary: "should not commit",
      }) } },
      { id: "c2", type: "function", function: { name: "ask_clarification", arguments: JSON.stringify({
        question: "Which heading?",
      }) } },
    ],
  });
  const { restore } = installFetchMock({
    "api.openai.com": [mixed],
  });
  try {
    const r = await callOpenAIMultiTurn({
      ...BASE_ARGS,
      dispatch: async () => { throw new Error("dispatch should not run"); },
    });
    assert.equal(r.kind, "clarification");
    assert.match(r.clarification.question, /Which heading/);
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: edit wins over nav in same-turn tool_calls", async () => {
  // Secondary priority: when both edit_file and update_nav_config appear
  // in one message, the edit_file proposal wins (nav changes require a
  // more explicit prompt, so the edit is closer to the user's intent).
  const mixed = openaiMessage({
    tool_calls: [
      { id: "n1", type: "function", function: { name: "update_nav_config", arguments: JSON.stringify({
        items: [{ href: "x.html", label: "X" }],
        summary: "nav change",
      }) } },
      { id: "e1", type: "function", function: { name: "edit_file", arguments: JSON.stringify({
        edits: [{ find: "<p>hi</p>", replace: "<p>hello</p>" }],
        summary: "edit wins",
      }) } },
    ],
  });
  const { restore } = installFetchMock({
    "api.openai.com": [mixed],
  });
  try {
    const r = await callOpenAIMultiTurn({
      ...BASE_ARGS,
      navConfig: { items: [], raw: "{}" },
      dispatch: async () => { throw new Error("dispatch should not run"); },
    });
    assert.equal(r.kind, "edit");
    assert.equal(r.proposal.summary, "edit wins");
  } finally {
    restore();
  }
});

test("callOpenAIMultiTurn: ask_clarification beats further tool calls", async () => {
  const { calls, restore } = installFetchMock({
    "api.openai.com": [
      openaiReadPageTurn("docs/components.html", "c1"),
      openaiClarifyTurn({ question: "Which section?" }, "c2"),
      openaiPlainTurn("SHOULD NOT REACH"),
    ],
  });
  try {
    const r = await callOpenAIMultiTurn({
      ...BASE_ARGS,
      dispatch: async () => JSON.stringify({ path: "docs/components.html", title: "C", text: "x", truncated: false }),
    });
    assert.equal(r.kind, "clarification");
    assert.match(r.clarification.question, /Which section/);
    assert.equal(calls.filter((c) => c.url.includes("openai.com")).length, 2);
  } finally {
    restore();
  }
});
