// Claude (direct) adapter — real Anthropic tool-use loop.
//
// The whole turn orchestration (grounding, system-prompt assembly, the
// think -> call-tool -> observe loop, and turning the result into a reply or a
// proposal preview) is shared with the OpenAI adapter and lives in ./edit-turn.
// This file is just the Claude-specific wiring: config validation and binding
// the Anthropic model call (callClaudeMultiTurn) as edit-turn's `runModel`.

import type { Adapter } from "../types";
import { callClaudeMultiTurn } from "../lib/claude";
import { runEditTurn } from "./edit-turn";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export const claudeAdapter: Adapter = {
  id: "claude",
  label: "Claude (direct)",

  configError(settings) {
    const c = settings.claude;
    if (!c?.apiKey) return "Missing Anthropic API key";
    // Read mode is Q&A only - it needs GitHub read access for read_page but
    // the dispatcher degrades gracefully without it, so we only hard-gate
    // Edit (which commits). Default an absent mode to "edit" so validation
    // is conservative - exactly mirrors the OpenAI adapter.
    if ((settings.mode ?? "edit") === "read") return null;
    const hasApp = !!c.githubApp?.accessToken;
    const hasPat = !!c.githubToken;
    if (!hasApp && !hasPat) {
      return "GitHub not connected - sign in with GitHub or paste a PAT";
    }
    return null;
  },

  async chat(prompt, context, history, settings, opts) {
    const claude = settings.claude;
    if (!claude?.apiKey) {
      return { role: "assistant", content: "Claude settings missing - open the options page." };
    }
    return runEditTurn(prompt, context, history, settings, opts, (input) =>
      callClaudeMultiTurn({ apiKey: claude.apiKey, model: claude.model || DEFAULT_MODEL, ...input }),
    );
  },
};
