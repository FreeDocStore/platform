// Adapter registry + validation tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { getAdapter, listAdapters, AdapterError, validateSettings } = await import(
  await bundle("src/adapters/base.ts")
);

test("getAdapter returns the matching adapter for each implemented id", () => {
  // Adding a new adapter is now a one-line array edit instead of a new
  // copy-paste test. Same coverage as before.
  for (const id of ["claude", "openai"]) {
    const a = getAdapter(id);
    assert.equal(a?.id, id, `getAdapter('${id}') must return the matching adapter`);
  }
});

test("getAdapter returns null for unregistered adapter ids", () => {
  // github-agent and mcp are typed in the union but not implemented yet.
  // Previous bug: they silently fell back to the claude adapter.
  assert.equal(getAdapter("github-agent"), null);
  assert.equal(getAdapter("mcp"), null);
});

test("listAdapters returns only the implemented adapters", () => {
  const ids = listAdapters().map((a) => a.id).sort();
  assert.deepEqual(ids, ["claude", "openai"]);
});

test("validateSettings: unimplemented adapter surfaces a clear error", () => {
  const msg = validateSettings({ adapter: "github-agent" });
  assert.match(msg ?? "", /not implemented/i);
});

test("validateSettings: claude adapter requires API key + a GitHub credential", () => {
  // Missing everything -> API key complaint first.
  assert.match(validateSettings({ adapter: "claude" }) ?? "", /API key/i);

  // API key set but no GitHub credentials -> GitHub-connect complaint.
  assert.match(
    validateSettings({ adapter: "claude", claude: { apiKey: "k", model: "m" } }) ?? "",
    /GitHub/i
  );

  // PAT path is enough.
  assert.equal(
    validateSettings({
      adapter: "claude",
      claude: { apiKey: "k", model: "m", githubToken: "g" },
    }),
    null
  );

  // GitHub App path is also enough (access token present).
  assert.equal(
    validateSettings({
      adapter: "claude",
      claude: {
        apiKey: "k",
        model: "m",
        githubApp: { clientId: "Iv23li", accessToken: "gho_abc" },
      },
    }),
    null
  );
});

test("validateSettings: openai requires API key + model + GitHub", () => {
  assert.match(validateSettings({ adapter: "openai" }) ?? "", /API key/i);
  assert.match(
    validateSettings({ adapter: "openai", openai: { apiKey: "k", model: "" } }) ?? "",
    /model/i
  );
  // GitHub auth is shared with the claude block.
  assert.match(
    validateSettings({ adapter: "openai", openai: { apiKey: "k", model: "gpt-5.4" } }) ?? "",
    /GitHub/i
  );
  assert.equal(
    validateSettings({
      adapter: "openai",
      openai: { apiKey: "k", model: "gpt-5.4" },
      claude: { apiKey: "", model: "", githubToken: "g" },
    }),
    null
  );
});

test("AdapterError.cause is wired to the native Error.cause (ES2022)", () => {
  const inner = new Error("boom");
  const err = new AdapterError("wrap", { cause: inner });
  // Chrome/Node 18+ support Error.cause natively when passed via options.
  assert.equal(err.cause, inner);
  assert.equal(err.name, "AdapterError");
  assert.equal(err.message, "wrap");
});

test("AdapterError without cause leaves cause undefined (not a rogue field)", () => {
  const err = new AdapterError("no cause here");
  assert.equal(err.cause, undefined);
});
