import type { McpProps } from './helpers.js';

export class GitHubRestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubRestError';
  }
}

export function requireRepoRead(props: McpProps): string | undefined {
  if (props?.userId && !props.scopes?.includes('read')) {
    throw new Error('This MCP token does not include the read scope.');
  }
  return props?.githubAccessToken;
}

export async function githubJson<T>(url: string, token?: string, accept = 'application/vnd.github+json'): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      'User-Agent': 'freedocstore-mcp',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > 1_048_576) throw new GitHubRestError(response.status, 'GitHub response exceeds the 1 MiB processing limit.');
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > 1_048_576) {
    throw new GitHubRestError(response.status, 'GitHub response exceeds the 1 MiB processing limit.');
  }
  let data: any;
  try { data = body ? JSON.parse(body) : {}; }
  catch { throw new GitHubRestError(response.status, 'GitHub returned an invalid JSON response.'); }
  if (!response.ok) {
    const detail = typeof data?.message === 'string' ? data.message : 'request failed';
    throw new GitHubRestError(response.status, detail);
  }
  return data as T;
}

export function formatGitHubError(error: unknown, subject: string): string {
  if (error instanceof GitHubRestError) {
    if (error.status === 401 || error.status === 403) return `GitHub permission error while ${subject} (HTTP ${error.status}): ${error.message}. Check GitHub access and the MCP read scope.`;
    if (error.status === 404) return `GitHub resource not found or unavailable while ${subject} (HTTP 404).`;
    if (error.status === 429) return `GitHub rate limit reached while ${subject}. Retry later.`;
    if (error.status >= 500) return `GitHub is unavailable while ${subject} (HTTP ${error.status}). Retry later.`;
    return `GitHub request failed while ${subject} (HTTP ${error.status}): ${error.message}`;
  }
  return error instanceof Error ? `${subject}: ${error.message}` : `${subject}: upstream request failed.`;
}

export function textResult<T extends { content: Array<{ type: 'text'; text: string }> }>(result: T): string {
  return result.content.map((item) => item.text).join('\n');
}
