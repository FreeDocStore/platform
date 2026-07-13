import type { Hono } from "hono";
import { type Env, type Variables, type Session, BYOK_PROVIDERS } from "../types";
import { requireSession, readStoredSecret, storeSecret, userSecretKey } from "../lib/session";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

async function secretsStatus(env: Env, session: Session): Promise<Record<string, { configured: boolean; label: string }>> {
  const entries = await Promise.all(
    Object.keys(BYOK_PROVIDERS).map(async (provider) => {
      const stored = await readStoredSecret(env, session, provider);
      return [provider, stored ? { configured: true, label: stored.label } : { configured: false, label: "" }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function registerSecretsRoutes(app: App) {
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
}
