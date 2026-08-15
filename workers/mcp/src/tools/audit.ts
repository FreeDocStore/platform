import { type Env, type McpProps, userKvKey } from "./helpers.js";

export interface MutationRecord {
  tool: string;
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
}

/**
 * Append an audit entry for a mutating MCP tool call.
 *
 * Records who did what, keyed by `audit:<userId>:<ISO timestamp>` in FDS_API_KV.
 * No-ops when FDS_API_KV is unbound or the caller is unauthenticated, mirroring
 * the graceful-degradation pattern in readWorkspace — auditing must never be the
 * reason a write fails.
 */
export async function logMutation(env: Env, props: McpProps, record: MutationRecord): Promise<void> {
  if (!env.FDS_API_KV || !props?.userId) return;
  const at = new Date().toISOString();
  const entry = {
    at,
    userId: props.userId,
    login: props.login ?? null,
    provider: props.provider ?? null,
    ...record,
  };
  await env.FDS_API_KV.put(userKvKey(props.userId, `audit:${at}`), JSON.stringify(entry));
}
