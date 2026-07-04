#!/usr/bin/env bash
# Hook up the glassdocs debug bridge as a Claude Code MCP server.
# Idempotent: removes any existing registration first, then re-adds.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$DIR/server.mjs"
PORT="${GLASSDOCS_DEBUG_PORT:-8787}"
NAME="glassdocs-debug"

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' CLI not found on PATH." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' not found on PATH." >&2
  exit 1
fi

echo "Registering MCP server '$NAME' -> node $SERVER"
claude mcp remove "$NAME" >/dev/null 2>&1 || true
claude mcp add "$NAME" -- node "$SERVER"

echo
echo "Health check:"
claude mcp list 2>/dev/null | grep "$NAME" || echo "  (run 'claude mcp list' to verify)"

cat <<EOF

Done. Two remaining steps:
  1. Extension Options -> Developer / debug -> Debug sink URL:
       http://localhost:${PORT}/event
     (then Save; reload the extension)
  2. Restart Claude Code so the '$NAME' tools attach to your session.

Tail events without MCP:  tail -f "$DIR/events.jsonl" | jq .
EOF
