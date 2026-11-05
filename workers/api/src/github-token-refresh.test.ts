import { afterEach, describe, expect, it, vi } from "vitest";
import { sealSecret } from "./encryption";
import { ensureFreshGitHubToken, GitHubTokenRefreshCoordinator } from "./github-token-refresh";
import app from "./index";
import { SESSION_PREFIX, type Env, type Session } from "./types";

const accountId = "github_42";
const baseSession: Session = {
  id: "session-refresh",
  user: { id: accountId, provider: "github", login: "reader", name: "Reader", avatarUrl: "", githubUrl: "" },
  githubAccessToken: "old-access-value",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const encryptionKey = "0123456789abcdef0123456789abcdef";

async function fixture(overrides: Partial<Session> = {}) {
  const values = new Map<string, unknown>();
  const session = { ...baseSession, ...overrides };
  values.set(`${SESSION_PREFIX}${session.id}`, session);
  const kv = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { values.set(key, JSON.parse(value)); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
  };
  const storageValues = new Map<string, unknown>();
  let tail = Promise.resolve();
  const state = {
    storage: {
      get: vi.fn(async (key: string) => storageValues.get(key)),
      put: vi.fn(async (key: string, value: unknown) => { storageValues.set(key, value); }),
      setAlarm: vi.fn(async () => {}),
      delete: vi.fn(async (key: string) => { storageValues.delete(key); }),
    },
    blockConcurrencyWhile: vi.fn(async (callback: () => Promise<void>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try { await callback(); } finally { release(); }
    }),
  } as unknown as DurableObjectState;
  const env = {
    FDS_API_KV: kv,
    GH_APP_CLIENT_ID: "client-id",
    GH_APP_CLIENT_SECRET: "client-secret",
    FDS_KEY_ENCRYPTION_KEY: encryptionKey,
  } as unknown as Env;
  const coordinator = new GitHubTokenRefreshCoordinator(state, env);
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinator.fetch(new Request(input, init)) })),
  };
  (env as unknown as { GH_TOKEN_REFRESHER: typeof namespace }).GH_TOKEN_REFRESHER = namespace;
  const context = () => ({
    env,
    get: () => ({ id: session.id, user: session.user }),
  }) as never;
  return { env, kv, values, state, coordinator, context, session };
}

afterEach(() => vi.unstubAllGlobals());

describe("GitHub token refresh", () => {
  it("refreshes a near-expiry token and stores rotated credentials", async () => {
    const refresh = await sealSecret("refresh-old", encryptionKey);
    const f = await fixture({
      githubTokenExpiresAt: Date.now() + 60_000,
      githubRefreshToken: refresh,
      githubRefreshTokenExpiresAt: Date.now() + 10_000_000,
    });
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-new", expires_in: 3600, refresh_token: "refresh-new", refresh_token_expires_in: 7200 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42 })));
    vi.stubGlobal("fetch", upstream);

    await expect(ensureFreshGitHubToken(f.context())).resolves.toBe("access-new");
    const saved = f.values.get(`${SESSION_PREFIX}${f.session.id}`) as Session;
    expect(saved.githubAccessToken).toBe("access-new");
    expect(saved.githubTokenExpiresAt).toBeGreaterThan(Date.now());
    expect(saved.githubRefreshToken).not.toBe("refresh-new");
    await expect(import("./encryption").then(({ openSecret }) => openSecret({ ...saved.githubRefreshToken!, label: "refresh" }, encryptionKey))).resolves.toBe("refresh-new");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("returns a token with no expiry metadata without attempting refresh", async () => {
    const f = await fixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(ensureFreshGitHubToken(f.context())).resolves.toBe("old-access-value");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serializes concurrent refreshes and returns the rotated token to both requests", async () => {
    const refresh = await sealSecret("refresh-old", encryptionKey);
    const f = await fixture({
      githubTokenExpiresAt: Date.now() + 30_000,
      githubRefreshToken: refresh,
      githubRefreshTokenExpiresAt: Date.now() + 10_000_000,
    });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const upstream = vi.fn()
      .mockImplementationOnce(async () => { await blocked; return new Response(JSON.stringify({ access_token: "access-rotated", expires_in: 3600, refresh_token: "refresh-rotated", refresh_token_expires_in: 7200 })); })
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42 })));
    vi.stubGlobal("fetch", upstream);

    const first = ensureFreshGitHubToken(f.context());
    const second = ensureFreshGitHubToken(f.context());
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["access-rotated", "access-rotated"]);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("clears revoked credentials and marks the session for reauthorization", async () => {
    const refresh = await sealSecret("refresh-revoked", encryptionKey);
    const f = await fixture({ githubTokenExpiresAt: Date.now() - 1, githubRefreshToken: refresh, githubRefreshTokenExpiresAt: Date.now() + 100_000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "bad_refresh_token" }), { status: 401 })));

    await expect(ensureFreshGitHubToken(f.context())).resolves.toBeNull();
    const saved = f.values.get(`${SESSION_PREFIX}${f.session.id}`) as Session;
    expect(saved.githubAccessToken).toBeUndefined();
    expect(saved.githubRefreshToken).toBeUndefined();
    expect(saved.githubAuthorizationRevoked).toBe(true);
  });

  it("returns a token-free reauthorization response after revocation", async () => {
    const refresh = await sealSecret("refresh-revoked", encryptionKey);
    const f = await fixture({ githubTokenExpiresAt: Date.now() - 1, githubRefreshToken: refresh, githubRefreshTokenExpiresAt: Date.now() + 100_000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "bad_refresh_token" }), { status: 401 })));
    const response = await app.request("https://api.freedocstore.online/api/proxy?target=https%3A%2F%2Fapi.github.com%2Fuser", {
      headers: { Cookie: `fds_session=${f.session.id}` },
    }, f.env);
    expect(response.status).toBe(401);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "GitHub authorization has expired. Please sign in again.", reauthorizationRequired: true });
    expect(JSON.stringify(body)).not.toContain("old-access-value");
  });

  it("falls back to the existing token after a refresh network failure", async () => {
    const refresh = await sealSecret("refresh-old", encryptionKey);
    const f = await fixture({ githubTokenExpiresAt: Date.now() - 1, githubRefreshToken: refresh, githubRefreshTokenExpiresAt: Date.now() + 100_000 });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    await expect(ensureFreshGitHubToken(f.context())).resolves.toBe("old-access-value");
  });

  it("requires reauthorization without contacting GitHub when the refresh credential expired", async () => {
    const refresh = await sealSecret("refresh-old", encryptionKey);
    const f = await fixture({ githubTokenExpiresAt: Date.now() - 1, githubRefreshToken: refresh, githubRefreshTokenExpiresAt: Date.now() - 1 });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(ensureFreshGitHubToken(f.context())).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const saved = f.values.get(`${SESSION_PREFIX}${f.session.id}`) as Session;
    expect(saved.githubAuthorizationRevoked).toBe(true);
  });
});
