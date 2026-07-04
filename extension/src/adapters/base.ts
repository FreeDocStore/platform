// Adapter registry + helpers. Only adapters that actually have an
// implementation are registered. Asking for an unregistered id returns
// null so the caller can surface a clear error instead of silently
// running the wrong adapter.

import type { Adapter, AdapterId, Settings } from "../types";
import { claudeAdapter } from "./claude";
import { openaiAdapter } from "./openai";

const REGISTRY: Partial<Record<AdapterId, Adapter>> = {
  claude: claudeAdapter,
  openai: openaiAdapter,
  // github-agent and mcp intentionally absent until implemented.
};

export function getAdapter(id: AdapterId): Adapter | null {
  return REGISTRY[id] ?? null;
}

export function listAdapters(): Adapter[] {
  return Object.values(REGISTRY).filter((a): a is Adapter => a != null);
}

export class AdapterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    // ES2022 Error supports { cause } in options - pass it through so
    // `err.cause` is wired to the native field, not a custom property.
    super(message, options as ErrorOptions);
    this.name = "AdapterError";
  }
}

export function validateSettings(settings: Settings): string | null {
  const a = getAdapter(settings.adapter);
  if (a == null) return `Adapter '${settings.adapter}' is not implemented yet`;
  return a.configError(settings);
}
