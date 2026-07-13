import type { Hono } from "hono";
import { type Env, type Variables } from "../types";
import { requireSession, kvKeyFromPath, userKvKey } from "../lib/session";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

export function registerKvRoutes(app: App) {
  app.get("/", (c) => c.json({
    ok: true,
    name: "FreeDocStore API",
    publicBaseUrl: c.env.PUBLIC_BASE_URL,
    editorBaseUrl: c.env.EDITOR_BASE_URL,
  }));

  app.get("/api/health", (c) => c.json({ ok: true, service: "freedocstore-api" }));

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
}
