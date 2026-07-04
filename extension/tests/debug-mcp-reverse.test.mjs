// Integration test for the debug-mcp reverse channel that drives the
// edit->publish loop via MCP: prompts (send_message) and apply/cancel commands
// (apply_edit / cancel_edit) must round-trip through /inject, /command and
// /pending. Spawns the real server in collector-only mode (no stdin/MCP) on a
// private port and exercises it over HTTP.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../../tools/debug-mcp/server.mjs", import.meta.url));
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "x-glassdocs-debug": "1", "content-type": "application/json" };

async function waitHealthy(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("debug-mcp server did not become healthy");
}

const getJson = async (path, init) => (await fetch(`${BASE}${path}`, init)).json();

test("debug-mcp reverse channel: prompts + apply/cancel commands round-trip via /pending", async () => {
  const proc = spawn("node", [SERVER], {
    env: { ...process.env, GLASSDOCS_DEBUG_PORT: String(PORT), GLASSDOCS_DEBUG_COLLECTOR_ONLY: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await waitHealthy();

    // send_message twin: a prompt comes back under `prompts`, `commands` empty.
    await fetch(`${BASE}/inject`, { method: "POST", headers: H, body: JSON.stringify({ prompt: "create a credits page" }) });
    let pend = await getJson("/pending", { headers: H });
    assert.deepEqual(pend.prompts, ["create a credits page"]);
    assert.deepEqual(pend.commands, []);

    // FIFO drains one per poll: the next poll is empty.
    pend = await getJson("/pending", { headers: H });
    assert.deepEqual(pend.prompts, []);
    assert.deepEqual(pend.commands, []);

    // apply_edit twin: an apply command comes back under `commands`, carrying id.
    await fetch(`${BASE}/command`, { method: "POST", headers: H, body: JSON.stringify({ kind: "apply", proposalId: "p-123" }) });
    pend = await getJson("/pending", { headers: H });
    assert.deepEqual(pend.prompts, []);
    assert.deepEqual(pend.commands, [{ kind: "apply", proposalId: "p-123" }]);

    // cancel_edit twin without a specific id (defaults to latest preview).
    await fetch(`${BASE}/command`, { method: "POST", headers: H, body: JSON.stringify({ kind: "cancel" }) });
    pend = await getJson("/pending", { headers: H });
    assert.equal(pend.commands[0].kind, "cancel");
    assert.equal(pend.commands[0].proposalId, undefined);

    // A bad command kind is rejected, not queued.
    const bad = await fetch(`${BASE}/command`, { method: "POST", headers: H, body: JSON.stringify({ kind: "nope" }) });
    assert.equal(bad.status, 400);

    // The debug marker is required (loopback-only reverse channel).
    assert.equal((await fetch(`${BASE}/pending`)).status, 403);
    assert.equal((await fetch(`${BASE}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
  } finally {
    proc.kill("SIGKILL");
  }
});
