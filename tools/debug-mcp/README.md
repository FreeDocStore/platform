# glassdocs debug bridge (collector + MCP server)

A single zero-dependency Node process that gives an MCP client (e.g. Claude
Code) live, full transparency into what the Docs Chat extension is doing.

```
Docs Chat side panel ──POST /event──▶ collector (http://localhost:8787)
                                          │  in-memory ring + events.jsonl
Claude Code ──MCP stdio (tools)──────────┘
```

## What it captures

The side panel streams two event kinds when `settings.debug.sinkUrl` is set:

- **`log`** — every `dlog(...)` diagnostic line (context resolution, turn
  IDs, permission checks, repo-mirror results, errors).
- **`conversation`** — the full live message list (with content) on every
  persisted change, so a watcher sees what `log` truncates.

## Run it

```bash
node tools/debug-mcp/server.mjs        # collector on :8787, MCP on stdio
# optional: GLASSDOCS_DEBUG_PORT=9000 node tools/debug-mcp/server.mjs
```

Then in the extension Options → **Developer / debug** → set
**Debug sink URL** to `http://localhost:8787/event` and Save.

## Register with Claude Code

```bash
claude mcp add glassdocs-debug -- node /ABS/PATH/glassdocs/tools/debug-mcp/server.mjs
```

(Claude Code spawns the process over stdio; it also opens the HTTP collector
on startup.) Restart the session for the tools to appear.

## MCP tools

| Tool | Purpose |
|------|---------|
| `status` | Event counts by kind, last event time, port, uptime. |
| `get_recent_events` | Newest events; filter by `kind`, cap with `limit`. |
| `get_conversation` | Latest full conversation snapshot (message content). |
| `get_errors` | Failure-shaped events (error logs + error attachments). |
| `send_message` | Submit a prompt as the next chat turn (drives the agent). |
| `start_edit` | Start a fresh EDIT thread — same as clicking ✎. Call before editing (the default Ask thread is read-only). |
| `select_ask` | Switch back to the read-only Ask thread. |
| `apply_edit` | Apply (publish) the pending proposal — same as clicking Apply. |
| `cancel_edit` | Cancel the pending proposal — same as clicking Cancel. |
| `clear` | Drop the buffer and truncate `events.jsonl`. |

## Drive the full edit→publish loop via MCP

`start_edit` + `send_message` + `apply_edit` complete the loop headlessly (needs
**Options → allow reverse-drive/inject** enabled in the extension):

1. `start_edit` — switch to a fresh edit thread (the default Ask thread is
   read-only and will refuse edits). Skip if you only want to ask questions.
2. `send_message({ prompt: "add a credits page with fictional celeb names" })`
3. `get_conversation` — read the proposal the agent produced (a preview).
4. `apply_edit` — publishes it (commit / PR). Defaults to the latest pending
   preview; pass `{ proposalId }` to target a specific one.
5. `get_conversation` — the preview row is now a "Pushed to main …" /
   "PR opened …" result.

The side panel polls `GET /pending` (~1.5s) and performs one queued action per
poll, so actions serialize: apply waits for the proposing turn to finish. The
HTTP twins `POST /inject` (prompt) and `POST /command`
(`{kind:"apply"|"cancel"|"new_edit"|"select_ask", proposalId?}`) do the same
without an MCP client.

## Tail it directly (no MCP)

```bash
tail -f tools/debug-mcp/events.jsonl | jq .
```

## HTTP endpoints

- `POST /event` — append one event (the extension uses this).
- `GET /health` — `{ ok, count, port }`.
- `POST /clear` — drop the buffer + truncate the file.

`events.jsonl` is gitignored.
