#!/usr/bin/env node
// glassdocs debug bridge — collector + MCP server in one process.
//
// Two faces, one process:
//   1. HTTP collector on http://localhost:<PORT> (default 8787). The Docs
//      Chat side panel POSTs diagnostic events here when
//      settings.debug.sinkUrl is set to http://localhost:8787/event.
//   2. MCP server over stdio. Exposes tools (status, get_recent_events,
//      get_conversation, get_errors, clear) so an MCP client - e.g. Claude
//      Code - can query the live extension state in real time.
//
// Zero dependencies (Node built-ins only). MCP stdio transport is
// newline-delimited JSON-RPC 2.0. CRITICAL: stdout carries ONLY JSON-RPC;
// every other message goes to stderr, or the client's parser breaks.
//
// Events are kept in an in-memory ring buffer AND appended to events.jsonl
// next to this file, so they survive a client reconnect and can also be
// tailed directly (`tail -f tools/debug-mcp/events.jsonl`).

import http from "node:http";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GLASSDOCS_DEBUG_PORT || 8787);
const EVENTS_FILE = path.join(HERE, "events.jsonl");
const RING_MAX = 5000;
const SERVER_NAME = "glassdocs-debug";
const SERVER_VERSION = "0.1.0";

const startedAt = Date.now();
/** @type {Array<{seq:number, recvAt:number, ts?:number, kind?:string, scope?:string, payload?:unknown}>} */
const ring = [];
let seq = 0;

// Reverse channel: actions queued by an operator (me, via the MCP tools or
// POST /inject) for the extension to pick up and perform as if the user did
// them. The side panel polls GET /pending and performs one at a time.
//
// Item kinds that drive the full edit->publish loop headlessly:
//   - kind "prompt": submit `prompt` as the next chat turn (send_message).
//   - kind "apply" / "cancel": click Apply / Cancel on the pending proposal
//     preview (apply_edit / cancel_edit), optionally targeting `proposalId`.
//   - kind "new_edit" / "select_ask": switch the active thread (start_edit /
//     select_ask) so a following prompt runs in an edit or read-only thread.
// FIFO; /pending shifts a single item per poll so turns serialize cleanly.
/** @type {Array<{kind:"prompt"|"apply"|"cancel"|"new_edit"|"select_ask", prompt?:string, proposalId?:string, at:number}>} */
const injectQueue = [];
// Command kinds accepted by POST /command and forwarded to the panel via
// /pending. (Prompts use the separate POST /inject route.)
const COMMAND_KINDS = new Set(["apply", "cancel", "new_edit", "select_ask"]);

function log(...args) {
  // Never stdout - that channel is reserved for MCP JSON-RPC.
  process.stderr.write(`[${SERVER_NAME}] ${args.join(" ")}\n`);
}

const FILE_MAX_BYTES = 25 * 1024 * 1024; // rotate the on-disk log past 25MB
let appendsSinceCheck = 0;
function maybeRotateFile() {
  // Amortized: only stat once per 1000 appends. When the file exceeds the
  // cap, rewrite it from the bounded in-memory ring so the log can't grow
  // without limit (it holds page content + conversations).
  if (++appendsSinceCheck < 1000) return;
  appendsSinceCheck = 0;
  try {
    if (fs.statSync(EVENTS_FILE).size > FILE_MAX_BYTES) {
      fs.writeFileSync(EVENTS_FILE, ring.map((e) => JSON.stringify(e)).join("\n") + "\n");
      log(`rotated ${EVENTS_FILE} (kept ${ring.length} ring events)`);
    }
  } catch {
    /* stat/rewrite failed - non-fatal */
  }
}

function record(evt) {
  const stored = { seq: ++seq, recvAt: Date.now(), ...evt };
  ring.push(stored);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(stored) + "\n");
    maybeRotateFile();
  } catch (err) {
    log("append failed:", String(err));
  }
  return stored;
}

// ── HTTP collector ───────────────────────────────────────────────────

// NO wildcard CORS. The old `Access-Control-Allow-Origin: *` let any web
// page the user visited POST to /inject (driving the agent) or drain
// /pending. We now (a) send no permissive CORS headers, and (b) require a
// custom marker header on every sensitive route. A cross-origin page cannot
// set a custom header without a CORS preflight, which we don't approve, so
// its request is blocked; the extension reaches localhost via host_permission
// (CORS-exempt) and sends the header freely. The header is a marker, not a
// secret - its security comes from the browser's preflight, not from being
// unguessable.
const CORS = {};
const DEBUG_HEADER = "x-glassdocs-debug";

/** True when the request carries the extension's marker header. */
function hasMarker(req) {
  return typeof req.headers[DEBUG_HEADER] === "string";
}
function refuse(res) {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "missing debug marker header" }));
}

const httpServer = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    // Answer preflights WITHOUT allowing the custom header or a wildcard
    // origin, so a cross-origin page's preflight fails and its real request
    // never fires.
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { ...CORS, "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: ring.length, port: PORT }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/clear") {
    if (!hasMarker(req)) return refuse(res);
    ring.length = 0;
    try { fs.writeFileSync(EVENTS_FILE, ""); } catch { /* ignore */ }
    res.writeHead(200, { ...CORS, "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Operator -> extension: queue a prompt to be submitted as the user.
  if (req.method === "POST" && url.pathname === "/inject") {
    if (!hasMarker(req)) return refuse(res);
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", () => {
      try {
        const { prompt } = body ? JSON.parse(body) : {};
        if (!prompt || typeof prompt !== "string") {
          res.writeHead(400, { ...CORS, "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing 'prompt' string" }));
          return;
        }
        injectQueue.push({ kind: "prompt", prompt, at: Date.now() });
        log(`queued inject (${injectQueue.length} pending): ${prompt.slice(0, 80)}`);
        res.writeHead(200, { ...CORS, "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pending: injectQueue.length }));
      } catch (err) {
        res.writeHead(400, { ...CORS, "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  // Operator -> extension: queue an apply/cancel of the pending proposal.
  // The HTTP twin of the apply_edit / cancel_edit MCP tools.
  if (req.method === "POST" && url.pathname === "/command") {
    if (!hasMarker(req)) return refuse(res);
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 100_000) req.destroy(); });
    req.on("end", () => {
      try {
        const { kind, proposalId } = body ? JSON.parse(body) : {};
        if (!COMMAND_KINDS.has(kind)) {
          res.writeHead(400, { ...CORS, "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `kind must be one of ${[...COMMAND_KINDS].join(", ")}` }));
          return;
        }
        injectQueue.push({ kind, proposalId: typeof proposalId === "string" ? proposalId : undefined, at: Date.now() });
        log(`queued ${kind} (${injectQueue.length} pending)`);
        res.writeHead(200, { ...CORS, "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pending: injectQueue.length }));
      } catch (err) {
        res.writeHead(400, { ...CORS, "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  // Extension -> operator: poll for one queued action (FIFO, one per poll).
  // `prompts` stays for prompt items (backward compatible with older panels);
  // `commands` carries apply/cancel for panels that understand them.
  if (req.method === "GET" && url.pathname === "/pending") {
    if (!hasMarker(req)) return refuse(res);
    const next = injectQueue.shift();
    const body = { prompts: [], commands: [] };
    if (next?.kind === "prompt" && next.prompt) {
      body.prompts.push(next.prompt);
    } else if (next && COMMAND_KINDS.has(next.kind)) {
      body.commands.push({ kind: next.kind, proposalId: next.proposalId });
    }
    res.writeHead(200, { ...CORS, "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/event") {
    if (!hasMarker(req)) return refuse(res);
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 5_000_000) req.destroy(); // 5MB guard
    });
    req.on("end", () => {
      try {
        const evt = body ? JSON.parse(body) : {};
        record(evt);
        res.writeHead(204, CORS);
        res.end();
      } catch (err) {
        res.writeHead(400, { ...CORS, "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  res.writeHead(404, CORS);
  res.end();
});

httpServer.on("error", (err) => {
  log(`HTTP collector error on :${PORT}:`, String(err));
  if (err.code === "EADDRINUSE") {
    log(`Port ${PORT} already in use - another collector is probably running. Exiting so we don't double-bind. Set GLASSDOCS_DEBUG_PORT to use a different port.`);
    process.exit(1);
  }
});

httpServer.listen(PORT, "127.0.0.1", () => {
  log(`collector listening on http://localhost:${PORT}  (POST /event, GET /health, POST /clear)`);
  log(`events file: ${EVENTS_FILE}`);
});

// ── MCP tools ────────────────────────────────────────────────────────

function summarizeByKind() {
  const counts = {};
  for (const e of ring) counts[e.kind ?? "?"] = (counts[e.kind ?? "?"] ?? 0) + 1;
  return counts;
}

const TOOLS = [
  {
    name: "status",
    description: "Health of the debug bridge: total events buffered, a breakdown by event kind, the last event time, the collector port, and uptime.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const last = ring[ring.length - 1];
      return {
        port: PORT,
        eventsBuffered: ring.length,
        byKind: summarizeByKind(),
        lastEventAt: last ? new Date(last.recvAt).toISOString() : null,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        eventsFile: EVENTS_FILE,
      };
    },
  },
  {
    name: "get_recent_events",
    description: "Return the most recent events (newest last). Optionally filter by `kind` (e.g. 'log', 'conversation'). `limit` defaults to 50.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max events to return (default 50)." },
        kind: { type: "string", description: "Only return events of this kind." },
      },
      additionalProperties: false,
    },
    handler: ({ limit = 50, kind } = {}) => {
      let evts = ring;
      if (kind) evts = evts.filter((e) => e.kind === kind);
      return evts.slice(-Math.max(1, limit));
    },
  },
  {
    name: "get_conversation",
    description: "Return the latest full conversation snapshot the side panel streamed (the live message list, with content). Empty until the user sends a message with a conversation event.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].kind === "conversation") {
          return { scope: ring[i].scope, at: new Date(ring[i].recvAt).toISOString(), ...ring[i].payload };
        }
      }
      return { messages: [], note: "no conversation event received yet" };
    },
  },
  {
    name: "get_errors",
    description: "Return events that look like failures: 'error'-kind events, log lines whose label mentions error/fail, and conversation messages carrying an error attachment. `limit` defaults to 20.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max items (default 20)." } },
      additionalProperties: false,
    },
    handler: ({ limit = 20 } = {}) => {
      const out = [];
      for (const e of ring) {
        if (e.kind === "error") { out.push(e); continue; }
        if (e.kind === "log") {
          const label = e.payload && typeof e.payload === "object" ? String(e.payload.label ?? "") : "";
          if (/error|fail/i.test(label)) out.push(e);
          continue;
        }
        if (e.kind === "sw") {
          const event = e.payload && typeof e.payload === "object" ? String(e.payload.event ?? "") : "";
          if (/error|fail/i.test(event)) out.push(e);
          continue;
        }
        if (e.kind === "conversation" && e.payload && Array.isArray(e.payload.messages)) {
          for (const m of e.payload.messages) {
            if (m?.attachment?.kind === "error") out.push({ seq: e.seq, recvAt: e.recvAt, kind: "conversation.error", message: m });
          }
        }
      }
      return out.slice(-Math.max(1, limit));
    },
  },
  {
    name: "send_message",
    description: "Send a message into the extension's chat on the user's behalf. The prompt is queued; the side panel polls and submits it as the next user turn. Use to drive the agent for testing, then read the reply with get_conversation.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", description: "The message to send into the chat." } },
      required: ["prompt"],
      additionalProperties: false,
    },
    handler: ({ prompt } = {}) => {
      if (!prompt || typeof prompt !== "string") throw new Error("prompt (string) required");
      injectQueue.push({ prompt, at: Date.now() });
      return { queued: true, pending: injectQueue.length };
    },
  },
  {
    name: "apply_edit",
    description: "Apply (publish) the pending proposal in the side panel - the same as clicking the Apply button on the preview. Use after send_message produces a proposal (check with get_conversation) to complete the edit->publish loop headlessly. Applies the most recent pending preview unless `proposalId` is given. Read the result with get_conversation (it becomes a 'Pushed'/'PR opened' message).",
    inputSchema: {
      type: "object",
      properties: { proposalId: { type: "string", description: "Optional. Target a specific proposal; defaults to the latest pending preview." } },
      additionalProperties: false,
    },
    handler: ({ proposalId } = {}) => {
      injectQueue.push({ kind: "apply", proposalId: typeof proposalId === "string" ? proposalId : undefined, at: Date.now() });
      return { queued: true, action: "apply", pending: injectQueue.length };
    },
  },
  {
    name: "cancel_edit",
    description: "Cancel (dismiss) the pending proposal in the side panel - the same as clicking Cancel on the preview. Applies to the most recent pending preview unless `proposalId` is given.",
    inputSchema: {
      type: "object",
      properties: { proposalId: { type: "string", description: "Optional. Target a specific proposal; defaults to the latest pending preview." } },
      additionalProperties: false,
    },
    handler: ({ proposalId } = {}) => {
      injectQueue.push({ kind: "cancel", proposalId: typeof proposalId === "string" ? proposalId : undefined, at: Date.now() });
      return { queued: true, action: "cancel", pending: injectQueue.length };
    },
  },
  {
    name: "start_edit",
    description: "Start a fresh EDIT thread in the side panel - the same as clicking the ✎ button. The default 'Ask' thread is read-only and refuses edits; call this first, then send_message with the change you want so the agent produces an editable proposal. No-op guidance appears in the chat if the current repo is read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      injectQueue.push({ kind: "new_edit", at: Date.now() });
      return { queued: true, action: "new_edit", pending: injectQueue.length };
    },
  },
  {
    name: "select_ask",
    description: "Switch the side panel back to the read-only 'Ask' thread (questions only, no edits). The counterpart to start_edit.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      injectQueue.push({ kind: "select_ask", at: Date.now() });
      return { queued: true, action: "select_ask", pending: injectQueue.length };
    },
  },
  {
    name: "clear",
    description: "Drop all buffered events and truncate the events file. Use to start a clean debugging run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const had = ring.length;
      ring.length = 0;
      try { fs.writeFileSync(EVENTS_FILE, ""); } catch { /* ignore */ }
      return { cleared: had };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ── MCP stdio JSON-RPC ───────────────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleRpc(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize":
      reply(id, {
        // Echo the client's protocol version when offered for max compat.
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case "notifications/initialized":
    case "initialized":
      return; // notification, no response
    case "ping":
      if (isRequest) reply(id, {});
      return;
    case "tools/list":
      reply(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
      return;
    case "tools/call": {
      const tool = TOOL_BY_NAME.get(params?.name);
      if (!tool) { replyError(id, -32602, `Unknown tool: ${params?.name}`); return; }
      try {
        const result = tool.handler(params?.arguments ?? {});
        reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        reply(id, { isError: true, content: [{ type: "text", text: `Tool error: ${String(err)}` }] });
      }
      return;
    }
    default:
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`);
  }
}

// Collector-only mode: run just the HTTP collector, no MCP/stdio. Used to
// keep a long-lived collector up (e.g. started in the background) so the
// extension has somewhere to POST even when no MCP client is attached.
// The listening HTTP server keeps the event loop alive.
if (process.env.GLASSDOCS_DEBUG_COLLECTOR_ONLY) {
  log("collector-only mode: stdin/MCP disabled; HTTP collector only");
} else {
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    log("non-JSON line on stdin:", trimmed.slice(0, 120));
    return;
  }
  try {
    handleRpc(msg);
  } catch (err) {
    log("handler threw:", String(err));
  }
});

rl.on("close", () => {
  log("stdin closed - MCP client disconnected; shutting down");
  httpServer.close(() => process.exit(0));
  // Hard stop if close hangs.
  setTimeout(() => process.exit(0), 500);
});

log(`MCP server ready (${SERVER_NAME} v${SERVER_VERSION})`);
}
