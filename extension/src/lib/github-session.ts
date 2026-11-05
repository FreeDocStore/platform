import { refreshAccessToken, type GitHubToken } from '../auth/github-device';
import { loadStoredSettings, patchStoredSettings } from '../settings';
import type { Settings } from '../types';
import { DEFAULT_GITHUB_APP_CLIENT_ID } from '../config';
import { withExtensionLock } from './locks';

export interface AppContext {
  clientId: string;
  refreshToken: string;
  accessToken: string;
  username?: string;
}
type StoredApp = NonNullable<NonNullable<Settings['claude']>['githubApp']>;
const inFlight = new Map<string, Promise<GitHubToken>>();

export class GithubSessionExpired extends Error {
  constructor() { super('Your GitHub sign-in has expired, was revoked, or changed. Sign in with GitHub again.'); }
}

function compatible(stored: StoredApp | undefined, ctx: AppContext): stored is StoredApp {
  return !!stored?.accessToken && !!stored.refreshToken && (stored.clientId || DEFAULT_GITHUB_APP_CLIENT_ID) === ctx.clientId &&
    !(stored.username && ctx.username && stored.username.toLowerCase() !== ctx.username.toLowerCase());
}
function storedToken(stored: StoredApp): GitHubToken {
  return { accessToken: stored.accessToken!, refreshToken: stored.refreshToken, expiresAt: stored.expiresAt ?? 0, scope: '' };
}
function changed(stored: StoredApp, ctx: AppContext) {
  return stored.refreshToken !== ctx.refreshToken || stored.accessToken !== ctx.accessToken;
}
function terminal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP (?:429|5\d\d)\b/i.test(message)) return false;
  return /\b(?:invalid_grant|bad_refresh_token|unauthorized_client|incorrect_client_credentials)\b/i.test(message);
}

/** Persist or adopt inside the same settings transaction that checks identity. */
async function settle(ctx: AppContext, fresh: GitHubToken | null): Promise<GitHubToken> {
  let result: GitHubToken | null = null;
  await patchStoredSettings(current => {
    const stored = current.claude?.githubApp;
    if (!compatible(stored, ctx)) return {};
    if (changed(stored, ctx)) { result = storedToken(stored); return {}; }
    if (!fresh) return { claude: { ...current.claude!, githubApp: { ...stored, accessToken: '', refreshToken: '', expiresAt: 0, username: '' } } };
    result = fresh;
    return { claude: { ...current.claude!, githubApp: { ...stored, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken ?? ctx.refreshToken, expiresAt: fresh.expiresAt } } };
  });
  if (!result) throw new GithubSessionExpired();
  return result;
}

/** The shared promise stays registered until credential persistence completes. */
export function refreshGithubSession(ctx: AppContext): Promise<GitHubToken> {
  const key = `${ctx.clientId}:${ctx.refreshToken}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const refresh = async () => {
    const stored = (await loadStoredSettings()).claude?.githubApp;
    if (!compatible(stored, ctx)) throw new GithubSessionExpired();
    if (changed(stored, ctx)) return storedToken(stored);
    let fresh;
    try { fresh = await refreshAccessToken(ctx.clientId, ctx.refreshToken); }
    catch (error) {
      if (!terminal(error)) throw error;
      return settle(ctx, null);
    }
    return settle(ctx, fresh);
  };
  const promise = (async () => {
    // Lock diagnostics must not expose the actual credential.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const lock = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return withExtensionLock(`freedocstore.github.refresh.${lock}`, refresh);
  })().finally(() => { inFlight.delete(key); });
  inFlight.set(key, promise);
  return promise;
}
