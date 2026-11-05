import type { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  type Env,
  type Variables,
  type Session,
  type GitHubUser,
  type GoogleUser,
  STATE_PREFIX,
  SESSION_PREFIX,
  USER_KV_PREFIX,
  USER_SESSION_PREFIX,
  STATE_TTL,
  BYOK_PROVIDERS,
} from "../types";
import {
  requireSecret,
  safeNext,
  writeSession,
  setSessionCookie,
  clearSessionCookie,
  requireSession,
  userSecretKey,
} from "../lib/session";
import { sealSecret } from "../encryption";
import { forgetGitHubTokenSession } from "../github-token-refresh";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

function parseState(raw: string, provider: string): { next?: string } | null {
  try {
    const state = JSON.parse(raw);
    return state && state.provider === provider && (state.next === undefined || typeof state.next === 'string') ? state : null;
  } catch { return null; }
}

export function registerAuthRoutes(app: App) {
  app.get("/api/me", (c) => {
    const session = c.get("session");
    return c.json({
      authenticated: Boolean(session),
      user: session?.user ?? null,
    });
  });

  app.get("/auth/github/start", async (c) => {
    requireSecret(c.env.GH_APP_CLIENT_ID, "GH_APP_CLIENT_ID");
    const state = crypto.randomUUID();
    const next = safeNext(c.req.query("next"), c.env.EDITOR_BASE_URL);
    await c.env.FDS_API_KV.put(`${STATE_PREFIX}${state}`, JSON.stringify({ provider: "github", next }), { expirationTtl: STATE_TTL });
    setCookie(c, "__Host-fds-oauth-github", state, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: STATE_TTL });
    const callback = new URL("/auth/github/callback", c.req.url);
    // GitHub App user-to-server authorization: no `scope` — access comes from the
    // App's fine-grained permissions and the repos the user grants at install time.
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", c.env.GH_APP_CLIENT_ID!);
    url.searchParams.set("redirect_uri", callback.toString());
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  app.get("/auth/github/callback", async (c) => {
    requireSecret(c.env.GH_APP_CLIENT_ID, "GH_APP_CLIENT_ID");
    requireSecret(c.env.GH_APP_CLIENT_SECRET, "GH_APP_CLIENT_SECRET");
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.text("Missing OAuth code or state", 400);
    // The server-side nonce must also belong to the browser that started sign-in.
    if (getCookie(c, "__Host-fds-oauth-github") !== state) return c.text("Sign-in state does not match this browser. Start sign-in again.", 400);
    deleteCookie(c, "__Host-fds-oauth-github", { secure: true, path: "/" });
    const stateRaw = await c.env.FDS_API_KV.get(`${STATE_PREFIX}${state}`);
    if (!stateRaw) return c.text("OAuth state expired", 400);
    await c.env.FDS_API_KV.delete(`${STATE_PREFIX}${state}`);
    const parsedState = parseState(stateRaw, 'github');
    if (!parsedState) return c.text('OAuth state does not match this sign-in provider', 400);
    const { next } = parsedState;
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: c.env.GH_APP_CLIENT_ID,
        client_secret: c.env.GH_APP_CLIENT_SECRET,
        code,
        redirect_uri: new URL("/auth/github/callback", c.req.url).toString(),
      }),
    });
    const tokenData = await tokenRes.json<{ access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; error?: string; error_description?: string }>();
    if (!tokenData.access_token) return c.text("GitHub OAuth failed. Please start sign-in again.", 401);
    if (tokenData.refresh_token) requireSecret(c.env.FDS_KEY_ENCRYPTION_KEY, "FDS_KEY_ENCRYPTION_KEY");
    const tokenReceivedAt = Date.now();

    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenData.access_token}`,
        "User-Agent": "freedocstore-api",
      },
    });
    if (!userRes.ok) return c.text(`GitHub user lookup failed: ${userRes.status}`, 401);
    const gh = await userRes.json<GitHubUser>();
    const session: Session = {
      id: crypto.randomUUID(),
      user: {
        id: `github_${gh.id}`,
        provider: "github",
        login: gh.login,
        name: gh.name || gh.login,
        avatarUrl: gh.avatar_url || "",
        githubUrl: gh.html_url || `https://github.com/${gh.login}`,
      },
      githubAccessToken: tokenData.access_token,
      githubTokenExpiresAt: typeof tokenData.expires_in === "number" && Number.isFinite(tokenData.expires_in) && tokenData.expires_in > 0 ? tokenReceivedAt + tokenData.expires_in * 1000 : undefined,
      githubRefreshToken: tokenData.refresh_token && c.env.FDS_KEY_ENCRYPTION_KEY
        ? await sealSecret(tokenData.refresh_token, c.env.FDS_KEY_ENCRYPTION_KEY)
        : undefined,
      githubRefreshTokenExpiresAt: typeof tokenData.refresh_token_expires_in === "number" && Number.isFinite(tokenData.refresh_token_expires_in) && tokenData.refresh_token_expires_in > 0
        ? tokenReceivedAt + tokenData.refresh_token_expires_in * 1000
        : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeSession(c.env, session);
    setSessionCookie(c, session.id);
    return c.redirect(safeNext(next, c.env.EDITOR_BASE_URL), 302);
  });

  app.get("/auth/google/start", async (c) => {
    requireSecret(c.env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
    const state = crypto.randomUUID();
    const next = safeNext(c.req.query("next"), c.env.EDITOR_BASE_URL);
    await c.env.FDS_API_KV.put(`${STATE_PREFIX}${state}`, JSON.stringify({ provider: "google", next }), { expirationTtl: STATE_TTL });
    setCookie(c, "__Host-fds-oauth-google", state, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: STATE_TTL });
    const callback = new URL("/auth/google/callback", c.req.url);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID!);
    url.searchParams.set("redirect_uri", callback.toString());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");
    return c.redirect(url.toString(), 302);
  });

  app.get("/auth/google/callback", async (c) => {
    requireSecret(c.env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
    requireSecret(c.env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET");
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.text("Missing OAuth code or state", 400);
    // The server-side nonce must also belong to the browser that started sign-in.
    if (getCookie(c, "__Host-fds-oauth-google") !== state) return c.text("Sign-in state does not match this browser. Start sign-in again.", 400);
    deleteCookie(c, "__Host-fds-oauth-google", { secure: true, path: "/" });
    const stateRaw = await c.env.FDS_API_KV.get(`${STATE_PREFIX}${state}`);
    if (!stateRaw) return c.text("OAuth state expired", 400);
    await c.env.FDS_API_KV.delete(`${STATE_PREFIX}${state}`);
    const parsedState = parseState(stateRaw, 'google');
    if (!parsedState) return c.text('OAuth state does not match this sign-in provider', 400);
    const { next } = parsedState;
    const callback = new URL("/auth/google/callback", c.req.url);
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.env.GOOGLE_CLIENT_ID!,
        client_secret: c.env.GOOGLE_CLIENT_SECRET!,
        code,
        grant_type: "authorization_code",
        redirect_uri: callback.toString(),
      }),
    });
    const tokenData = await tokenRes.json<{ access_token?: string; error?: string; error_description?: string }>();
    if (!tokenData.access_token) return c.text(tokenData.error_description || tokenData.error || "Google OAuth failed", 401);

    const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });
    if (!userRes.ok) return c.text(`Google user lookup failed: ${userRes.status}`, 401);
    const google = await userRes.json<GoogleUser>();
    const login = google.email?.split("@")[0] || `google-${google.sub.slice(0, 8)}`;
    const session: Session = {
      id: crypto.randomUUID(),
      user: {
        id: `google_${google.sub}`,
        provider: "google",
        login,
        name: google.name || login,
        avatarUrl: google.picture || "",
        githubUrl: google.profile || "",
        email: google.email,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeSession(c.env, session);
    setSessionCookie(c, session.id);
    return c.redirect(safeNext(next, c.env.EDITOR_BASE_URL), 302);
  });

  app.post("/api/logout", async (c) => {
    const session = c.get("session");
    if (session) {
      await c.env.FDS_API_KV.delete(`${SESSION_PREFIX}${session.id}`);
      if (session.user.provider === "github") await forgetGitHubTokenSession(c.env, session.id);
    }
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.delete("/api/account", async (c) => {
    const session = requireSession(c);
    await c.env.FDS_API_KV.delete(`${USER_KV_PREFIX}${session.user.id}:fds:config:v1`);
    await c.env.FDS_API_KV.delete(`${USER_KV_PREFIX}${session.user.id}:fds:kbs:v1`);
    await c.env.FDS_API_KV.delete(`${USER_KV_PREFIX}${session.user.id}:fds:active-kb:v1`);
    await Promise.all(Object.keys(BYOK_PROVIDERS).map((provider) => c.env.FDS_API_KV.delete(userSecretKey(session, provider))));
    await c.env.FDS_API_KV.delete(`${SESSION_PREFIX}${session.id}`);
    if (session.user.provider === "github") await forgetGitHubTokenSession(c.env, session.id);
    await c.env.FDS_API_KV.delete(`${USER_SESSION_PREFIX}${session.user.id}`);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });
}
