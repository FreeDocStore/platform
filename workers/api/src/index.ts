import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { publishKb, type PublishFile } from "./publish";
import { commitFiles } from "./github";
import { sealSecret, openSecret, type StoredSecret } from "./encryption";

interface Env {
  FDS_API_KV: KVNamespace;
  EDITOR_BASE_URL: string;
  PUBLIC_BASE_URL: string;
  COOKIE_DOMAIN?: string;
  GITHUB_ORG: string;
  GH_APP_CLIENT_ID?: string;
  GH_APP_CLIENT_SECRET?: string;
  GITHUB_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  FDS_KEY_ENCRYPTION_KEY?: string;
}

type AuthProvider = "github" | "google";

interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  html_url?: string | null;
}

interface GoogleUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  profile?: string;
}

interface Session {
  id: string;
  user: {
    id: string;
    provider: AuthProvider;
    login: string;
    name: string;
    avatarUrl: string;
    githubUrl: string;
    email?: string;
  };
  githubAccessToken?: string;
  createdAt: string;
  updatedAt: string;
}

type Variables = {
  session: Session | null;
};

const SESSION_COOKIE = "fds_session";
const STATE_PREFIX = "oauth_state:";
const SESSION_PREFIX = "session:";
const USER_SESSION_PREFIX = "user_session:";
const USER_KV_PREFIX = "user_kv:";
const USER_SECRET_PREFIX = "user_secret:";
const SESSION_TTL = 60 * 60 * 24 * 30;
const STATE_TTL = 60 * 10;

interface ByokProvider {
  /** Third-party API host the proxy injects this key for. */
  host: string;
  /** Accepted key format. */
  prefix: RegExp;
}

const BYOK_PROVIDERS: Record<string, ByokProvider> = {
  openai: { host: "api.openai.com", prefix: /^sk-[A-Za-z0-9_-]{12,}$/ },
  anthropic: { host: "api.anthropic.com", prefix: /^sk-ant-[A-Za-z0-9_-]{12,}$/ },
};

const PROXY_HOST_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.entries(BYOK_PROVIDERS).map(([id, p]) => [p.host, id]),
);

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed = allowedOrigin(c.env, origin);
  if (allowed) {
    c.header("Access-Control-Allow-Origin", allowed);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Vary", "Origin");
  }
  c.header("Access-Control-Allow-Headers", "Content-Type, Accept, X-GitHub-Api-Version");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  c.set("session", await readSession(c.env, getCookie(c, SESSION_COOKIE)));
  await next();
});

app.get("/", (c) => c.json({
  ok: true,
  name: "FreeDocStore API",
  publicBaseUrl: c.env.PUBLIC_BASE_URL,
  editorBaseUrl: c.env.EDITOR_BASE_URL,
}));

app.get("/api/health", (c) => c.json({ ok: true, service: "freedocstore-api" }));

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
  const stateRaw = await c.env.FDS_API_KV.get(`${STATE_PREFIX}${state}`);
  if (!stateRaw) return c.text("OAuth state expired", 400);
  await c.env.FDS_API_KV.delete(`${STATE_PREFIX}${state}`);
  const { next } = JSON.parse(stateRaw) as { next?: string };
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
  const tokenData = await tokenRes.json<{ access_token?: string; error?: string; error_description?: string }>();
  if (!tokenData.access_token) return c.text(tokenData.error_description || tokenData.error || "GitHub OAuth failed", 401);

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
  const stateRaw = await c.env.FDS_API_KV.get(`${STATE_PREFIX}${state}`);
  if (!stateRaw) return c.text("OAuth state expired", 400);
  await c.env.FDS_API_KV.delete(`${STATE_PREFIX}${state}`);
  const { next } = JSON.parse(stateRaw) as { next?: string };
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
  if (session) await c.env.FDS_API_KV.delete(`${SESSION_PREFIX}${session.id}`);
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
  await c.env.FDS_API_KV.delete(`${USER_SESSION_PREFIX}${session.user.id}`);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get("/api/billing", (c) => {
  return c.json({
    plan: "free",
    status: "free",
    billingEnabled: false,
  });
});

app.get("/api/kv/*", async (c) => {
  const session = requireSession(c);
  const key = kvKeyFromPath(c.req.path);
  const value = await c.env.FDS_API_KV.get(userKvKey(session, key), "json");
  return c.json({ key, value });
});

app.put("/api/kv/*", async (c) => {
  const session = requireSession(c);
  const key = kvKeyFromPath(c.req.path);
  const value = (await c.req.json<{ value: unknown }>()).value;
  await c.env.FDS_API_KV.put(userKvKey(session, key), JSON.stringify(value));
  return c.json({ ok: true });
});

app.delete("/api/kv/*", async (c) => {
  const session = requireSession(c);
  const key = kvKeyFromPath(c.req.path);
  await c.env.FDS_API_KV.delete(userKvKey(session, key));
  return c.json({ ok: true });
});

async function secretsStatus(env: Env, session: Session): Promise<Record<string, { configured: boolean; label: string }>> {
  const entries = await Promise.all(
    Object.keys(BYOK_PROVIDERS).map(async (provider) => {
      const stored = await readStoredSecret(env, session, provider);
      return [provider, stored ? { configured: true, label: stored.label } : { configured: false, label: "" }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

app.get("/api/secrets", async (c) => {
  const session = requireSession(c);
  return c.json(await secretsStatus(c.env, session));
});

app.put("/api/secrets/:provider", async (c) => {
  const session = requireSession(c);
  const provider = c.req.param("provider");
  const spec = BYOK_PROVIDERS[provider];
  if (!spec) return c.json({ error: `Unknown provider: ${provider}` }, 400);
  const body: { value?: unknown } = await c.req.json<{ value?: unknown }>().catch(() => ({}));
  const value = typeof body.value === "string" ? body.value.trim() : "";
  if (!value) return c.json({ error: `${provider} API key is required` }, 400);
  if (!spec.prefix.test(value)) return c.json({ error: `${provider} API key format is not valid` }, 400);
  await storeSecret(c.env, session, provider, value);
  return c.json({ ok: true, ...(await secretsStatus(c.env, session)) });
});

app.delete("/api/secrets/:provider", async (c) => {
  const session = requireSession(c);
  const provider = c.req.param("provider");
  if (!BYOK_PROVIDERS[provider]) return c.json({ error: `Unknown provider: ${provider}` }, 400);
  await c.env.FDS_API_KV.delete(userSecretKey(session, provider));
  return c.json({ ok: true, ...(await secretsStatus(c.env, session)) });
});

app.post("/api/publish", async (c) => {
  const session = requireSession(c);
  if (!session.githubAccessToken) {
    return c.json({ error: "Publishing requires signing in with GitHub (repo access)." }, 403);
  }
  const body = await c.req.json<{
    title?: string;
    slug?: string;
    owner?: string;
    customDomain?: string;
    description?: string;
    visibility?: string;
    files?: PublishFile[];
  }>();
  if (body.visibility === "private") {
    return c.json({ error: "FreeDocStore publishes public knowledge bases only. Private KBs belong in ProDocStore." }, 400);
  }
  const title = (body.title ?? "").trim();
  const slug = (body.slug ?? "").trim().toLowerCase();
  const owner = (body.owner ?? c.env.GITHUB_ORG).trim();
  const files = Array.isArray(body.files) ? body.files : [];
  if (!title) return c.json({ error: "Missing title" }, 400);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return c.json({ error: "Slug must be lowercase letters, digits, and dashes" }, 400);
  if (!files.length || files.length > 100) return c.json({ error: "files must contain 1-100 entries" }, 400);
  for (const file of files) {
    if (typeof file?.path !== "string" || typeof file?.content !== "string") return c.json({ error: "Each file needs path and content" }, 400);
    if (file.path.startsWith("/") || file.path.split("/").includes("..")) return c.json({ error: `Invalid file path: ${file.path}` }, 400);
    if (file.content.length > 512 * 1024) return c.json({ error: `File too large: ${file.path}` }, 400);
  }
  if (!files.some((file) => file.path === ".github/workflows/deploy.yml")) {
    return c.json({ error: "files must include .github/workflows/deploy.yml" }, 400);
  }
  const result = await publishKb({
    title,
    slug,
    owner,
    customDomain: body.customDomain?.trim() || undefined,
    description: body.description?.trim() || undefined,
    files,
    userToken: session.githubAccessToken,
    platformToken: c.env.GITHUB_TOKEN,
    org: c.env.GITHUB_ORG,
  });
  return c.json(result, result.ok ? 200 : 502);
});

app.post("/api/edit", async (c) => {
  const session = requireSession(c);
  if (!session.githubAccessToken) {
    return c.json({ error: "Editing requires signing in with GitHub (repo access)." }, 403);
  }
  const body = await c.req.json<{
    repo?: string;
    path?: string;
    content?: string;
    message?: string;
    mode?: string;
    branch?: string;
  }>();
  const repo = (body.repo ?? "").trim();
  const path = (body.path ?? "").trim();
  const content = typeof body.content === "string" ? body.content : "";
  const mode = body.mode === "direct" ? "direct" : "pr";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return c.json({ error: "repo must be owner/name" }, 400);
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return c.json({ error: `Invalid path: ${path}` }, 400);
  if (!content.trim()) return c.json({ error: "content is required" }, 400);
  if (content.length > 512 * 1024) return c.json({ error: "content too large" }, 400);
  const message = (body.message ?? `Update ${path} via FreeDocStore`).slice(0, 120);
  const result = await commitFiles({
    token: session.githubAccessToken,
    repoFullName: repo,
    message,
    files: [{ path, content }],
    baseBranch: body.branch?.trim() || "main",
    mode,
    prTitle: message,
    prBody: `Proposed through the FreeDocStore console by ${session.user.login}.`,
  });
  return c.json(result, result.ok ? 200 : 502);
});

app.all("/api/proxy", async (c) => {
  const session = requireSession(c);
  const target = c.req.query("target");
  if (!target) return c.json({ error: "Missing target" }, 400);
  const url = normalizeProxyTarget(target);
  const headers = new Headers();
  const accept = c.req.header("Accept");
  const contentType = c.req.header("Content-Type");
  if (accept) headers.set("Accept", accept);
  if (contentType) headers.set("Content-Type", contentType);

  const provider = PROXY_HOST_PROVIDER[url.hostname];
  if (url.hostname === "api.github.com") {
    const isWrite = c.req.method !== "GET" && c.req.method !== "HEAD";
    const token = isWrite ? session.githubAccessToken : session.githubAccessToken || c.env.GITHUB_TOKEN;
    if (isWrite && !token) {
      return c.json({ error: "GitHub writes go through your own account. Sign in with GitHub (granting repo access) and try again." }, 403);
    }
    headers.set("Authorization", `Bearer ${token || ""}`);
    headers.set("User-Agent", "freedocstore-api");
    headers.set("X-GitHub-Api-Version", c.req.header("X-GitHub-Api-Version") || "2022-11-28");
  } else if (url.hostname === "models.github.ai") {
    // Free AI tier: GitHub Models, authenticated with the signed-in user's GitHub
    // token (falls back to the platform token). Rate-limited by GitHub; on 429 the
    // console prompts the user to add their own OpenAI/Anthropic key.
    const token = session.githubAccessToken || c.env.GITHUB_TOKEN;
    if (!token) return c.json({ error: "Sign in with GitHub to use the free AI tier." }, 403);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("User-Agent", "freedocstore-api");
  } else if (provider) {
    const stored = await readStoredSecret(c.env, session, provider);
    if (!stored) return c.json({ error: `${provider} BYOK key is not configured. Add your ${provider} key in Profile > Platform connections.` }, 400);
    const key = await decryptSecret(c.env, stored);
    if (provider === "anthropic") {
      headers.set("x-api-key", key);
      headers.set("anthropic-version", c.req.header("anthropic-version") || "2023-06-01");
    } else {
      headers.set("Authorization", `Bearer ${key}`);
    }
  } else {
    return c.json({ error: "Proxy target is not allowed" }, 403);
  }

  const body = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.arrayBuffer();
  const upstream = await fetch(url, { method: c.req.method, headers, body });
  const responseHeaders = proxyResponseHeaders(upstream.headers);
  applyCorsHeaders(c, responseHeaders);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return corsErrorResponse(c, err.getResponse());
  console.error(err);
  return corsErrorResponse(c, c.json({ error: "Internal server error" }, 500));
});

export default app;

function allowedOrigin(env: Env, origin: string | undefined): string | null {
  if (!origin) return null;
  const originUrl = safeUrl(origin);
  if (originUrl?.hostname === "freedocstore-editor.pages.dev" || originUrl?.hostname.endsWith(".freedocstore-editor.pages.dev")) return origin;
  const allowed = new Set([
    env.EDITOR_BASE_URL,
    env.PUBLIC_BASE_URL,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:4220",
  ]);
  return allowed.has(origin) ? origin : null;
}

function safeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function applyCorsHeaders(c: Parameters<Parameters<typeof app.onError>[0]>[1], headers: Headers) {
  const origin = c.req.header("Origin");
  const allowed = allowedOrigin(c.env, origin);
  if (!allowed) return;
  headers.set("Access-Control-Allow-Origin", allowed);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
}

function corsErrorResponse(c: Parameters<Parameters<typeof app.onError>[0]>[1], response: Response): Response {
  const origin = c.req.header("Origin");
  const allowed = allowedOrigin(c.env, origin);
  if (!allowed) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowed);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readSession(env: Env, id: string | undefined): Promise<Session | null> {
  if (!id) return null;
  return env.FDS_API_KV.get<Session>(`${SESSION_PREFIX}${id}`, "json");
}

async function writeSession(env: Env, session: Session) {
  await Promise.all([
    env.FDS_API_KV.put(`${SESSION_PREFIX}${session.id}`, JSON.stringify(session), { expirationTtl: SESSION_TTL }),
    env.FDS_API_KV.put(`${USER_SESSION_PREFIX}${session.user.id}`, session.id, { expirationTtl: SESSION_TTL }),
  ]);
}

function setSessionCookie(c: Parameters<typeof setCookie>[0], id: string) {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

function clearSessionCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, SESSION_COOKIE, {
    secure: true,
    sameSite: "None",
    path: "/",
  });
}

function requireSession(c: Parameters<typeof app.fetch>[0] extends never ? never : any): Session {
  const session = c.get("session") as Session | null;
  if (!session) throwJson(401, "Authentication required");
  return session;
}

function requireSecret(value: string | undefined, name: string) {
  if (!value) throwJson(500, `${name} is not configured`);
}

function safeNext(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  try {
    const next = new URL(input, fallback);
    const allowed = new URL(fallback);
    return next.origin === allowed.origin ? next.toString() : fallback;
  } catch {
    return fallback;
  }
}

function kvKeyFromPath(path: string): string {
  const key = decodeURIComponent(path.replace(/^\/api\/kv\/?/, ""));
  if (!key || key.includes("..") || key.length > 256) throwJson(400, "Invalid key");
  return key;
}

function userKvKey(session: Session, key: string) {
  return `${USER_KV_PREFIX}${session.user.id}:${key}`;
}

function userSecretKey(session: Session, key: string) {
  return `${USER_SECRET_PREFIX}${session.user.id}:${key}`;
}

function redactSecret(value: string) {
  if (value.length <= 10) return "configured";
  return `${value.slice(0, 7)}...${value.slice(-4)}`;
}

async function readStoredSecret(env: Env, session: Session, provider: string): Promise<StoredSecret | null> {
  const raw = await env.FDS_API_KV.get(userSecretKey(session, provider));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSecret>;
    if (parsed.v === 2 && parsed.keyCiphertext && parsed.dekWrapped && parsed.iv) {
      return { v: 2, keyCiphertext: parsed.keyCiphertext, dekWrapped: parsed.dekWrapped, iv: parsed.iv, label: parsed.label || "configured" };
    }
  } catch {
    // Pre-vault-v2 values cannot be read; the user re-enters the key once.
  }
  return null;
}

async function storeSecret(env: Env, session: Session, provider: string, value: string): Promise<string> {
  requireSecret(env.FDS_KEY_ENCRYPTION_KEY, "FDS_KEY_ENCRYPTION_KEY");
  const sealed = await sealSecret(value, env.FDS_KEY_ENCRYPTION_KEY!);
  const label = redactSecret(value);
  await env.FDS_API_KV.put(userSecretKey(session, provider), JSON.stringify({ ...sealed, label }));
  return label;
}

async function decryptSecret(env: Env, secret: StoredSecret): Promise<string> {
  requireSecret(env.FDS_KEY_ENCRYPTION_KEY, "FDS_KEY_ENCRYPTION_KEY");
  return openSecret(secret, env.FDS_KEY_ENCRYPTION_KEY!);
}

function normalizeProxyTarget(target: string): URL {
  const withScheme = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:") throwJson(400, "Proxy target must use HTTPS");
  return url;
}

function throwJson(status: 400 | 401 | 500, error: string): never {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
}

function proxyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ["content-type", "etag", "last-modified", "cache-control"]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
