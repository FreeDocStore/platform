import type { Hono } from "hono";
import { type Env, type Variables, PROXY_HOST_PROVIDER } from "../types";
import {
  requireSession,
  normalizeProxyTarget,
  readStoredSecret,
  decryptSecret,
  proxyResponseHeaders,
  applyCorsHeaders,
} from "../lib/session";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

export function registerProxyRoutes(app: App) {
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
      // Only send Authorization when we actually have a token. An empty
      // `Bearer ` header makes GitHub reject an otherwise-valid anonymous read
      // (e.g. a Google-authed user reading a public repo with no platform token).
      if (token) headers.set("Authorization", `Bearer ${token}`);
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
}
