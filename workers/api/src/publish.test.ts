import { afterEach, describe, expect, it, vi } from "vitest";
import { publishKb, type PublishInput } from "./publish";

const ORG = "FreeDocStore";

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}
function unb64(b: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
}

interface MockOpts {
  login?: string;
  repoCreateStatus?: number; // 201 default; 422 → reuse path
  failAt?: "tree"; // force a mid-pipeline failure
  registry?: { knowledge_bases: any[] };
  existing?: Record<string, unknown>;
  registryFailure?: number;
  conflicts?: number;
  competingClaim?: boolean;
}

/** Stateful mock of the GitHub REST surface publish.ts touches. */
function mockGitHub(opts: MockOpts = {}) {
  const registry = opts.registry ?? { knowledge_bases: [] };
  let registrySha = "reg-sha-0";
  const calls: Array<{ method: string; path: string }> = [];
  let commitN = 0;
  let conflicts = opts.conflicts ?? 0;

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    calls.push({ method, path });

    if (path === "/user" && method === "GET") return json({ login: opts.login ?? "octocat" });

    if ((path === "/user/repos" || path === `/orgs/${ORG}/repos`) && method === "POST") {
      const status = opts.repoCreateStatus ?? 201;
      if (status === 422) return json({ message: "name already exists" }, 422);
      const name = JSON.parse(String(init!.body)).name;
      const owner = path === "/user/repos" ? opts.login ?? "octocat" : ORG;
      return json({ full_name: `${owner}/${name}`, html_url: `https://github.com/${owner}/${name}`, private: false, default_branch: 'main' }, 201);
    }
    if (path.startsWith(`/repos/${ORG}/`) && path.endsWith("/contents/site/registry.json")) {
      if (method === "GET") return opts.registryFailure ? json({ message: 'registry unavailable' }, opts.registryFailure) : json({ content: b64(JSON.stringify(registry)), sha: registrySha });
      if (method === "PUT") {
        if (conflicts-- > 0) {
          registry.knowledge_bases.push({ id: opts.competingClaim ? 'test-kb' : `concurrent-${conflicts}`, source: { repo: 'other/concurrent' } });
          return json({ message: 'SHA changed' }, 409);
        }
        const body = JSON.parse(String(init!.body));
        Object.assign(registry, JSON.parse(unb64(body.content)));
        registrySha = `reg-sha-${Date.now()}`;
        return json({ commit: { sha: "reg-commit" } }, 200);
      }
    }
    // repo metadata read (422 reuse path)
    if (/^\/repos\/[^/]+\/[^/]+$/.test(path) && method === "GET") {
      const [, , owner, name] = path.split("/");
      return json({ full_name: `${owner}/${name}`, html_url: `https://github.com/${owner}/${name}`, private: false, permissions: { push: true }, default_branch: 'main', ...opts.existing });
    }
    if (path.endsWith("/git/ref/heads/main") && method === "GET") return json({ object: { sha: "head-sha" } });
    if (path.includes("/git/commits/") && method === "GET") return json({ tree: { sha: "base-tree" } });
    if (path.endsWith("/git/blobs") && method === "POST") return json({ sha: `blob-${++commitN}` }, 201);
    if (path.endsWith("/git/trees") && method === "POST") {
      if (opts.failAt === "tree") return json({ message: "tree boom" }, 500);
      return json({ sha: "new-tree" }, 201);
    }
    if (path.endsWith("/git/commits") && method === "POST") {
      return json({ sha: "new-commit", html_url: "https://github.com/commit" }, 201);
    }
    if (path.endsWith("/git/refs/heads/main") && method === "PATCH") return json({ object: { sha: "new-commit" } });

    return json({ message: `unexpected ${method} ${path}` }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    registry,
    calls,
    putCount: () => calls.filter((c) => c.method === "PUT" && c.path.endsWith("registry.json")).length,
  };
}

function input(over: Partial<PublishInput> = {}): PublishInput {
  return {
    title: "Test KB",
    slug: "test-kb",
    owner: ORG,
    description: "A test knowledge base",
    files: [
      { path: "docs/index.md", content: "# Test\n" },
      { path: ".github/workflows/deploy.yml", content: "name: Deploy\n" },
    ],
    userToken: "gho_user",
    platformToken: "ghp_platform",
    org: ORG,
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("publishKb", () => {
  it('refuses a slug owned by another repository before any GitHub mutation', async () => {
    const gh = mockGitHub({ registry: { knowledge_bases: [{ id: 'TEST-KB', source: { repo: 'someone/other' } }] } });
    const result = await publishKb(input());
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('already belongs');
    expect(gh.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('refuses a domain already registered to a different KB', async () => {
    const gh = mockGitHub({ registry: { knowledge_bases: [{ id: 'other', source: { repo: 'someone/other' }, cloudflare: { production_url: 'https://docs.example.com/' } }] } });
    expect((await publishKb(input({ customDomain: 'docs.example.com' }))).ok).toBe(false);
    expect(gh.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it.each([{ private: true }, { private: undefined }, { permissions: { push: false } }, { archived: true }, { default_branch: 'master' }, { full_name: 'other/wrong' }])('does not reuse an unsafe repository %j', async existing => {
    const gh = mockGitHub({ repoCreateStatus: 422, existing });
    expect((await publishKb(input())).ok).toBe(false);
    expect(gh.calls.some(call => call.path.includes('/git/'))).toBe(false);
    expect(gh.putCount()).toBe(0);
  });

  it('fails closed when the registry cannot be checked', async () => {
    const gh = mockGitHub({ registryFailure: 503 });
    expect((await publishKb(input())).ok).toBe(false);
    expect(gh.calls).toHaveLength(1);
  });

  it('preserves concurrent additions after a registry SHA conflict', async () => {
    const gh = mockGitHub({ conflicts: 1 });
    expect((await publishKb(input())).ok).toBe(true);
    expect(gh.registry.knowledge_bases.map(kb => kb.id)).toEqual(['test-kb', 'concurrent-0']);
  });
  it('stops before workflow writes if another repository wins the namespace race', async () => {
    const gh = mockGitHub({ conflicts: 1, competingClaim: true });
    const result = await publishKb(input());
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.detail).toContain('already belongs');
    expect(gh.calls.some(call => call.path.includes('/git/'))).toBe(false);
    expect(gh.putCount()).toBe(1);
  });

  it("creates repo, commits files, and registers the KB", async () => {
    const gh = mockGitHub();
    const result = await publishKb(input());
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.id)).toEqual(["repo", "registry", "files"]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.liveUrl).toBe("https://test-kb.freedocstore.online/");
    expect(gh.registry.knowledge_bases[0].id).toBe("test-kb");
    expect(gh.registry.knowledge_bases[0].cloudflare.custom_domains).toContain("test-kb.freedocstore.online");
  });

  it("reuses an existing repo on 422 instead of failing", async () => {
    const gh = mockGitHub({ repoCreateStatus: 422 });
    const result = await publishKb(input());
    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.id === "repo")!.detail).toMatch(/already existed/);
  });

  it("targets the user's own repos when owner matches the login", async () => {
    const gh = mockGitHub({ login: "octocat" });
    await publishKb(input({ owner: "octocat" }));
    expect(gh.calls.some((c) => c.method === "POST" && c.path === "/user/repos")).toBe(true);
    expect(gh.calls.some((c) => c.path === "/orgs/octocat/repos")).toBe(false);
  });

  it("claims the namespace before source writes and records source failures for retry", async () => {
    const gh = mockGitHub({ failAt: "tree" });
    const result = await publishKb(input());
    expect(result.ok).toBe(false);
    const files = result.steps.find((s) => s.id === "files")!;
    expect(files.ok).toBe(false);
    expect(gh.registry.knowledge_bases[0].status).toBe('failed');
    expect(gh.calls.findIndex(call => call.method === 'PUT' && call.path.endsWith('registry.json'))).toBeLessThan(gh.calls.findIndex(call => call.path.endsWith('/git/blobs')));
  });

  it("is idempotent: a second identical publish makes no second registry write", async () => {
    const gh = mockGitHub();
    await publishKb(input());
    expect(gh.putCount()).toBe(1);
    const second = await publishKb(input());
    expect(second.ok).toBe(true);
    expect(second.steps.find((s) => s.id === "registry")!.detail).toMatch(/already registered/);
    expect(gh.putCount()).toBe(1);
  });

  it("updates an existing registry entry when its metadata changes", async () => {
    const gh = mockGitHub();
    await publishKb(input({ description: "first" }));
    await publishKb(input({ description: "second" }));
    expect(gh.putCount()).toBe(2);
    expect(gh.registry.knowledge_bases[0].description).toBe("second");
    expect(gh.registry.knowledge_bases).toHaveLength(1);
  });
});
