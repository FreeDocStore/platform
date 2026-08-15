import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthHandler } from "../auth-handler";

// Scope note: the OAuth *provider* endpoints (discovery, dynamic client
// registration, /token issuance) are implemented by @cloudflare/workers-oauth-provider,
// which imports the `cloudflare:workers` runtime builtin and only runs under
// workerd. Exercising them for real needs @cloudflare/vitest-pool-workers; until
// that's wired up they're covered by the live mcp-remote smoke (issue #2, AC #4).
// These suites cover the FreeDocStore-owned /authorize and /callback flow.

// --- shared fakes -----------------------------------------------------------

/** In-memory KVNamespace covering get(text|json) / put / delete / list. */
function memKV() {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(key: string, opts?: string | { type?: string }) {
      const v = store.get(key);
      if (v == null) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, typeof value === "string" ? value : String(value));
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true as const, cursor: undefined };
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** OAuthHelpers stub — only the two methods auth-handler actually calls. */
function oauthProviderStub(over: Partial<Record<"parseAuthRequest" | "completeAuthorization", any>> = {}) {
  return {
    parseAuthRequest: vi.fn(async () => ({ clientId: "client-1", scope: "read write", redirectUri: "https://client.example/cb" })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: "https://client.example/cb?code=xyz" })),
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

// --- /authorize -------------------------------------------------------------

describe("auth-handler /authorize", () => {
  it("503 when the GitHub App is not configured", async () => {
    const env = { OAUTH_KV: memKV(), OAUTH_PROVIDER: oauthProviderStub() };
    const res = await AuthHandler.request("http://mcp.test/authorize?x=1", {}, env);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/not configured/i);
  });

  it("400 when the OAuth request is invalid", async () => {
    const provider = oauthProviderStub({
      parseAuthRequest: vi.fn(async () => {
        throw new Error("bad request");
      }),
    });
    const env = { OAUTH_KV: memKV(), GH_APP_CLIENT_ID: "cid", OAUTH_PROVIDER: provider };
    const res = await AuthHandler.request("http://mcp.test/authorize", {}, env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("bad request");
  });

  it("400 when the client id is missing", async () => {
    const provider = oauthProviderStub({ parseAuthRequest: vi.fn(async () => ({ clientId: "" })) });
    const env = { OAUTH_KV: memKV(), GH_APP_CLIENT_ID: "cid", OAUTH_PROVIDER: provider };
    const res = await AuthHandler.request("http://mcp.test/authorize", {}, env);
    expect(res.status).toBe(400);
  });

  it("redirects to GitHub and stashes the request under a nonce", async () => {
    const kv = memKV();
    const env = { OAUTH_KV: kv, GH_APP_CLIENT_ID: "cid", OAUTH_PROVIDER: oauthProviderStub() };
    const res = await AuthHandler.request("http://mcp.test/authorize?a=b", {}, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("cid");
    const state = loc.searchParams.get("state")!;
    expect(state).toBeTruthy();
    expect(loc.searchParams.get("redirect_uri")).toContain(`/callback?nonce=${state}`);
    // the parsed auth request was persisted keyed by the same nonce
    expect([...kv._store.keys()]).toContain(`authreq:${state}`);
  });
});

// --- /callback --------------------------------------------------------------

async function seedAuthReq(kv: ReturnType<typeof memKV>, nonce: string, scope = "read write") {
  await kv.put(`authreq:${nonce}`, JSON.stringify({ clientId: "client-1", scope, redirectUri: "https://client.example/cb" }));
}

describe("auth-handler /callback", () => {
  const configured = { GH_APP_CLIENT_ID: "cid", GH_APP_CLIENT_SECRET: "secret" };

  it("400 when state does not match the nonce", async () => {
    const env = { OAUTH_KV: memKV(), ...configured, OAUTH_PROVIDER: oauthProviderStub() };
    const res = await AuthHandler.request("http://mcp.test/callback?nonce=a&state=b&code=c", {}, env);
    expect(res.status).toBe(400);
  });

  it("400 when the code is missing", async () => {
    const env = { OAUTH_KV: memKV(), ...configured, OAUTH_PROVIDER: oauthProviderStub() };
    const res = await AuthHandler.request("http://mcp.test/callback?nonce=a&state=a", {}, env);
    expect(res.status).toBe(400);
  });

  it("503 when the GitHub App secret is not configured", async () => {
    const env = { OAUTH_KV: memKV(), GH_APP_CLIENT_ID: "cid", OAUTH_PROVIDER: oauthProviderStub() };
    const res = await AuthHandler.request("http://mcp.test/callback?nonce=a&state=a&code=c", {}, env);
    expect(res.status).toBe(503);
  });

  it("400 when the stored request has expired", async () => {
    const env = { OAUTH_KV: memKV(), ...configured, OAUTH_PROVIDER: oauthProviderStub() };
    const res = await AuthHandler.request("http://mcp.test/callback?nonce=n1&state=n1&code=c", {}, env);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired/i);
  });

  it("502 when the GitHub token exchange fails", async () => {
    const kv = memKV();
    await seedAuthReq(kv, "n2");
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "bad" }, 401)));
    const env = { OAUTH_KV: kv, ...configured, OAUTH_PROVIDER: oauthProviderStub() };
    const res = await AuthHandler.request("http://mcp.test/callback?nonce=n2&state=n2&code=c", {}, env);
    expect(res.status).toBe(502);
  });

  it("502 when GitHub returns no access token", async () => {
    const kv = memKV();
    await seedAuthReq(kv, "n3");
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "access_denied", error_description: "nope" })));
    const env = { OAUTH_KV: kv, ...configured, OAUTH_PROVIDER: oauthProviderStub() };
    const res = await AuthHandler.request("http://mcp.test/callback?nonce=n3&state=n3&code=c", {}, env);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/nope/);
  });

  it("502 when the GitHub user fetch fails", async () => {
    const kv = memKV();
    await seedAuthReq(kv, "n4");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("access_token")) return json({ access_token: "gho_x" });
      return json({ message: "boom" }, 500); // /user
    }));
    const env = { OAUTH_KV: kv, ...configured, OAUTH_PROVIDER: oauthProviderStub() };
    const res = await AuthHandler.request("http://mcp.test/callback?nonce=n4&state=n4&code=c", {}, env);
    expect(res.status).toBe(502);
  });

  it("completes authorization and normalizes scopes on success", async () => {
    const kv = memKV();
    await seedAuthReq(kv, "n5", "read write bogus");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("access_token")) return json({ access_token: "gho_x" });
      return json({ id: 42, login: "octocat", name: "Octo", avatar_url: "a", html_url: "h" });
    }));
    const provider = oauthProviderStub();
    const env = { OAUTH_KV: kv, ...configured, OAUTH_PROVIDER: provider };
    const res = await AuthHandler.request("http://mcp.test/callback?nonce=n5&state=n5&code=c", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://client.example/cb?code=xyz");
    expect(provider.completeAuthorization).toHaveBeenCalledTimes(1);
    const arg = provider.completeAuthorization.mock.calls[0][0];
    expect(arg.userId).toBe("github_42");
    expect(arg.scope).toEqual(["read", "write"]); // "bogus" dropped by parseScopes
    expect(arg.props.githubAccessToken).toBe("gho_x");
    // the one-time nonce is consumed
    expect(kv._store.has("authreq:n5")).toBe(false);
  });
});
