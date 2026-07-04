// OpenAI (direct) adapter. The shared proposal/apply/context logic lives in
// ./proposal-engine; this file is just the OpenAI-specific wiring: config
// validation and the multi-turn chat() that dispatches to the engine.

import type { Adapter } from "../types";
import { callOpenAIMultiTurn } from "../lib/openai";
import { runEditTurn } from "./edit-turn";

// Backward-compat barrel: the proposal engine's canonical home is
// ./proposal-engine, but re-export the surface here so the service worker /
// tests that imported it from the adapter keep working AND share the same
// module state (the activity/memory caches) as this adapter at runtime.
export {
  applyPendingProposal,
  invalidateCachesAfterApply,
  getRecentActivity,
  getRepoMemory,
  formatActivityBlock,
  formatMemoryBlock,
  mergeMemoryEntry,
  buildEditProposalPreview,
  buildNavProposalPreview,
  buildMemoryProposalPreview,
  toHistory,
  MEMORY_PATH,
} from "./proposal-engine";

export const openaiAdapter: Adapter = {
  id: "openai",
  label: "OpenAI (direct)",

  configError(settings) {
    const o = settings.openai;
    if (!o?.apiKey) return "Missing OpenAI API key";
    if (!o?.model) return "Missing OpenAI model";
    // Read mode is Q&A only - it never commits, but it DOES need GitHub
    // read access to run read_page. We keep the auth check gated on edit
    // mode only (read_page can still work, the dispatcher handles
    // no-credential cases by returning an error to the model).
    if ((settings.mode ?? "edit") === "read") return null;
    const hasApp = !!settings.claude?.githubApp?.accessToken;
    const hasPat = !!settings.claude?.githubToken;
    if (!hasApp && !hasPat) {
      return "GitHub not connected - sign in with GitHub or paste a PAT under the Claude section";
    }
    return null;
  },

  async chat(prompt, context, history, settings, opts) {
    const openai = settings.openai;
    if (!openai) {
      return { role: "assistant", content: "OpenAI settings missing - open the options page." };
    }
    return runEditTurn(prompt, context, history, settings, opts, (input) =>
      callOpenAIMultiTurn({ apiKey: openai.apiKey, model: openai.model, ...input }),
    );
  },
};

