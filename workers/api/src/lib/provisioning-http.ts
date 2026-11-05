export class ProvisioningError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 502 | 503, message: string, public retryAfterSeconds?: number) { super(message); }
}

export function retryDelay(headers: Headers, now = Date.now()): number {
  const retry = headers.get('retry-after');
  let seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry && /^[A-Za-z]{3,9},? /.test(retry) ? (Date.parse(retry) - now) / 1000 : NaN;
  if (!Number.isFinite(seconds)) {
    const reset = Number(headers.get('x-ratelimit-reset'));
    seconds = reset > 0 ? reset - now / 1000 : 60;
  }
  return Math.max(1, Math.min(86400, Math.ceil(seconds)));
}

export async function githubRequest<T = any>(token: string, path: string, init: { method?: string; body?: unknown; missing?: boolean } = {}): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method: init.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'freedocstore-api', 'X-GitHub-Api-Version': '2022-11-28', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch { throw new ProvisioningError(503, 'GitHub did not answer. Retry without changing your setup.'); }
  if (response.status === 404 && init.missing) return null;
  if (response.status >= 300 && response.status < 400) throw new ProvisioningError(409, 'The repository or resource moved. Refresh GitHub access and select its current name.');
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      const detail = await response.json().catch(() => null) as { message?: string } | null;
      if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /rate limit|abuse detection/i.test(detail?.message ?? '')) throw new ProvisioningError(503, 'GitHub’s request limit was reached. Wait before retrying.', retryDelay(response.headers));
    }
    if (response.status === 401) throw new ProvisioningError(401, 'GitHub authorization expired or was revoked. Sign in with GitHub again.');
    if (response.status === 403 || response.status === 404) throw new ProvisioningError(403, 'GitHub denied access. Check your organization role, app installation, selected repositories and repository permissions.');
    if (response.status === 409 || response.status === 422) throw new ProvisioningError(409, 'GitHub could not apply this setup. Refresh the repository, check branch protection and review any existing deployment configuration.');
    throw new ProvisioningError(503, 'GitHub is temporarily unavailable. Retry without changing your setup.');
  }
  if (response.status === 204) return null;
  try {
    const text = await response.text();
    return text ? JSON.parse(text) as T : null;
  }
  catch { throw new ProvisioningError(502, 'GitHub returned an invalid response. Retry.'); }
}
