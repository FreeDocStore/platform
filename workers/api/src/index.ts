import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { type Env, type Variables, SESSION_COOKIE } from "./types";
import { readSession, allowedOrigin, corsErrorResponse } from "./lib/session";
import { registerAuthRoutes } from "./routes/auth";
import { registerKvRoutes } from "./routes/kv";
import { registerSecretsRoutes } from "./routes/secrets";
import { registerPublishRoutes } from "./routes/publish";
import { registerProxyRoutes } from "./routes/proxy";

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

registerKvRoutes(app);
registerAuthRoutes(app);
registerSecretsRoutes(app);
registerPublishRoutes(app);
registerProxyRoutes(app);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return corsErrorResponse(c, err.getResponse());
  console.error(err);
  return corsErrorResponse(c, c.json({ error: "Internal server error" }, 500));
});

export default app;
