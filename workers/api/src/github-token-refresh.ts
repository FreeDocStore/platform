import type { Context } from "hono";
import { openSecret, sealSecret } from "./encryption";
import { readSession } from "./lib/session";
import { GITHUB_TOKEN_REFRESH_SKEW_MS, SESSION_PREFIX, type Env, type Session, type Variables } from "./types";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type RefreshReply = { outcome: "ok" | "reauthorize" | "unavailable"; accessToken?: string };

export async function forgetGitHubTokenSession(env: Env, sessionId: string) {
  try {
    const id = env.GH_TOKEN_REFRESHER.idFromName(sessionId);
    await env.GH_TOKEN_REFRESHER.get(id).fetch("https://github-token-refresh/forget", { method: "DELETE" });
  } catch { /* The durable object alarm still expires stored credentials. */ }
}

export async function ensureFreshGitHubToken(c: AppContext): Promise<string | null> {
  const current = c.get("session");
  if (!current || current.user.provider !== "github") return null;
  const session = await readSession(c.env, current.id);
  if (!session?.githubAccessToken) return null;
  if (!session.githubTokenExpiresAt || session.githubTokenExpiresAt > Date.now() + GITHUB_TOKEN_REFRESH_SKEW_MS) {
    return session.githubAccessToken;
  }

  try {
    const id = c.env.GH_TOKEN_REFRESHER.idFromName(session.id);
    const response = await c.env.GH_TOKEN_REFRESHER.get(id).fetch("https://github-token-refresh/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, accountId: session.user.id }),
    });
    if (!response.ok) return session.githubAccessToken;
    const reply = await response.json<RefreshReply>();
    if (reply.outcome === "reauthorize") return null;
    return reply.accessToken || session.githubAccessToken;
  } catch { return session.githubAccessToken; }
}

/** A single Durable Object instance serializes token rotation for each session. */
export class GitHubTokenRefreshCoordinator {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "DELETE") {
      await this.state.blockConcurrencyWhile(async () => { await this.state.storage.delete("credentials"); });
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    let input: { sessionId?: string; accountId?: string };
    try { input = await request.json(); } catch { return new Response("Invalid request", { status: 400 }); }
    if (!input.sessionId || !input.accountId || input.sessionId.length > 128 || input.accountId.length > 256) {
      return new Response("Invalid request", { status: 400 });
    }

    let reply: RefreshReply = { outcome: "unavailable" };
    await this.state.blockConcurrencyWhile(async () => {
      try { reply = await this.refresh(input.sessionId!, input.accountId!); }
      catch { reply = { outcome: "unavailable" }; }
    });
    return Response.json(reply);
  }

  private async refresh(sessionId: string, accountId: string): Promise<RefreshReply> {
    const stored = await this.state.storage.get<Pick<Session, "user" | "githubAccessToken" | "githubTokenExpiresAt" | "githubRefreshToken" | "githubRefreshTokenExpiresAt">>("credentials");
    const kvSession = await readSession(this.env, sessionId);
    const session = stored && stored.user.id === accountId && kvSession
      ? { ...kvSession, ...stored }
      : kvSession;
    if (!session || session.user.id !== accountId || session.user.provider !== "github" || !session.githubAccessToken) {
      return { outcome: "reauthorize" };
    }
    if (!session.githubTokenExpiresAt || session.githubTokenExpiresAt > Date.now() + GITHUB_TOKEN_REFRESH_SKEW_MS) {
      await this.save(session);
      return { outcome: "ok", accessToken: session.githubAccessToken };
    }
    if (!session.githubRefreshToken || !session.githubRefreshTokenExpiresAt || session.githubRefreshTokenExpiresAt <= Date.now()) {
      await this.clear(session);
      return { outcome: "reauthorize" };
    }
    if (!this.env.GH_APP_CLIENT_ID || !this.env.GH_APP_CLIENT_SECRET || !this.env.FDS_KEY_ENCRYPTION_KEY) {
      return { outcome: "unavailable" };
    }

    let refreshToken: string;
    try { refreshToken = await openSecret({ ...session.githubRefreshToken, label: "GitHub refresh credential" }, this.env.FDS_KEY_ENCRYPTION_KEY); }
    catch { await this.clear(session); return { outcome: "reauthorize" }; }

    let response: Response;
    let data: { access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; error?: string };
    try {
      response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.env.GH_APP_CLIENT_ID,
          client_secret: this.env.GH_APP_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      data = await response.json();
    } catch { return { outcome: "unavailable" }; }
    const receivedAt = Date.now();

    if (!response.ok || !data.access_token) {
      if (["bad_refresh_token", "bad_verification_code", "token_expired"].includes(data.error || "") || response.status === 400 || response.status === 401) {
        await this.clear(session);
        return { outcome: "reauthorize" };
      }
      return { outcome: "unavailable" };
    }

    const identity = await fetch("https://api.github.com/user", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${data.access_token}`, "User-Agent": "freedocstore-api" },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!identity?.ok) {
      if (identity?.status === 401) { await this.clear(session); return { outcome: "reauthorize" }; }
      return { outcome: "unavailable" };
    }
    const user = await identity.json<{ id?: number }>().catch((): null => null);
    if (!user || typeof user.id !== "number") return { outcome: "unavailable" };
    if (`github_${user.id}` !== accountId) {
      await this.clear(session);
      return { outcome: "reauthorize" };
    }

    const next: Session = {
      ...session,
      githubAccessToken: data.access_token,
      githubTokenExpiresAt: typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? receivedAt + data.expires_in * 1000 : undefined,
      githubRefreshToken: data.refresh_token
        ? await sealSecret(data.refresh_token, this.env.FDS_KEY_ENCRYPTION_KEY)
        : session.githubRefreshToken,
      githubRefreshTokenExpiresAt: typeof data.refresh_token_expires_in === "number" && Number.isFinite(data.refresh_token_expires_in) && data.refresh_token_expires_in > 0
        ? receivedAt + data.refresh_token_expires_in * 1000
        : session.githubRefreshTokenExpiresAt,
      updatedAt: new Date(receivedAt).toISOString(),
    };
    await this.save(next);
    return { outcome: "ok", accessToken: next.githubAccessToken };
  }

  private async save(session: Session) {
    await this.state.storage.put("credentials", {
      user: session.user,
      githubAccessToken: session.githubAccessToken,
      githubTokenExpiresAt: session.githubTokenExpiresAt,
      githubRefreshToken: session.githubRefreshToken,
      githubRefreshTokenExpiresAt: session.githubRefreshTokenExpiresAt,
    });
    await this.env.FDS_API_KV.put(`${SESSION_PREFIX}${session.id}`, JSON.stringify(session), { expirationTtl: 60 * 60 * 24 * 30 });
    await this.state.storage.setAlarm(Date.now() + 60 * 60 * 24 * 30 * 1000);
  }

  private async clear(session: Session) {
    const cleared: Session = {
      ...session,
      githubAccessToken: undefined,
      githubTokenExpiresAt: undefined,
      githubRefreshToken: undefined,
      githubRefreshTokenExpiresAt: undefined,
      githubAuthorizationRevoked: true,
      updatedAt: new Date().toISOString(),
    };
    await this.save(cleared);
  }

  async alarm() {
    await this.state.storage.delete("credentials");
  }
}
