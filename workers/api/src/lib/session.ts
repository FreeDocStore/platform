import type { Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { sealSecret, openSecret, type StoredSecret } from "../encryption";
import {
  type Env,
  type Session,
  type Variables,
  SESSION_COOKIE,
  SESSION_PREFIX,
  USER_SESSION_PREFIX,
  USER_KV_PREFIX,
  USER_SECRET_PREFIX,
  SESSION_TTL,
} from "../types";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export function allowedOrigin(env: Env, origin: string | undefined): string | null {
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

export function safeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

export function applyCorsHeaders(c: AppContext, headers: Headers) {
  const origin = c.req.header("Origin");
  const allowed = allowedOrigin(c.env, origin);
  if (!allowed) return;
  headers.set("Access-Control-Allow-Origin", allowed);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
}

export function corsErrorResponse(c: AppContext, response: Response): Response {
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

export async function readSession(env: Env, id: string | undefined): Promise<Session | null> {
  if (!id) return null;
  return env.FDS_API_KV.get<Session>(`${SESSION_PREFIX}${id}`, "json");
}

export async function writeSession(env: Env, session: Session) {
  await Promise.all([
    env.FDS_API_KV.put(`${SESSION_PREFIX}${session.id}`, JSON.stringify(session), { expirationTtl: SESSION_TTL }),
    env.FDS_API_KV.put(`${USER_SESSION_PREFIX}${session.user.id}`, session.id, { expirationTtl: SESSION_TTL }),
  ]);
}

export function setSessionCookie(c: Parameters<typeof setCookie>[0], id: string) {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

export function clearSessionCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, SESSION_COOKIE, {
    secure: true,
    sameSite: "None",
    path: "/",
  });
}

export function requireSession(c: AppContext): Session {
  const session = c.get("session") as Session | null;
  if (!session) throwJson(401, "Authentication required");
  return session;
}

export function requireSecret(value: string | undefined, name: string) {
  if (!value) throwJson(500, `${name} is not configured`);
}

export function safeNext(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  try {
    const next = new URL(input, fallback);
    const allowed = new URL(fallback);
    return next.origin === allowed.origin ? next.toString() : fallback;
  } catch {
    return fallback;
  }
}

export function kvKeyFromPath(path: string): string {
  const key = decodeURIComponent(path.replace(/^\/api\/kv\/?/, ""));
  if (!key || key.includes("..") || key.length > 256) throwJson(400, "Invalid key");
  return key;
}

export function userKvKey(session: Session, key: string) {
  return `${USER_KV_PREFIX}${session.user.id}:${key}`;
}

export function userSecretKey(session: Session, key: string) {
  return `${USER_SECRET_PREFIX}${session.user.id}:${key}`;
}

export function redactSecret(value: string) {
  if (value.length <= 10) return "configured";
  return `${value.slice(0, 7)}...${value.slice(-4)}`;
}

export async function readStoredSecret(env: Env, session: Session, provider: string): Promise<StoredSecret | null> {
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

export async function storeSecret(env: Env, session: Session, provider: string, value: string): Promise<string> {
  requireSecret(env.FDS_KEY_ENCRYPTION_KEY, "FDS_KEY_ENCRYPTION_KEY");
  const sealed = await sealSecret(value, env.FDS_KEY_ENCRYPTION_KEY!);
  const label = redactSecret(value);
  await env.FDS_API_KV.put(userSecretKey(session, provider), JSON.stringify({ ...sealed, label }));
  return label;
}

export async function decryptSecret(env: Env, secret: StoredSecret): Promise<string> {
  requireSecret(env.FDS_KEY_ENCRYPTION_KEY, "FDS_KEY_ENCRYPTION_KEY");
  return openSecret(secret, env.FDS_KEY_ENCRYPTION_KEY!);
}

export function normalizeProxyTarget(target: string): URL {
  const withScheme = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:") throwJson(400, "Proxy target must use HTTPS");
  return url;
}

export function throwJson(status: 400 | 401 | 500, error: string): never {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
}

export function proxyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ["content-type", "etag", "last-modified", "cache-control"]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
