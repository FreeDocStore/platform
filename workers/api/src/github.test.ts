import { afterEach, describe, expect, it, vi } from "vitest";
import { commitFiles } from "./github";

const REPO = "FreeDocStore/true-non-profit";

interface MockOpts {
  failAt?: "ref" | "tree" | "pr";
  unchanged?: boolean;
  sourceStatus?: number;
  sourceSha?: string;
}

function mockGitHub(opts: MockOpts = {}) {
  const calls: Array<{ method: string; path: string; body?: any; query?: string }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, query: url.search });

    if (path.endsWith("/git/ref/heads/main") && method === "GET") {
      if (opts.failAt === "ref") return json({ message: "no ref" }, 404);
      return json({ object: { sha: "head-sha" } });
    }
    if (path.includes("/git/commits/") && method === "GET") return json({ tree: { sha: "base-tree" } });
    if (path.includes('/contents/')) return json({ sha: opts.sourceSha ?? 'current-sha' }, opts.sourceStatus ?? 200);
    if (path.endsWith("/git/blobs") && method === "POST") return json({ sha: "blob-1" }, 201);
    if (path.endsWith("/git/trees") && method === "POST") {
      if (opts.failAt === "tree") return json({ message: "tree boom" }, 500);
      return json({ sha: opts.unchanged ? "base-tree" : "new-tree" }, 201);
    }
    if (path.endsWith("/git/commits") && method === "POST") return json({ sha: "new-commit", html_url: "https://github.com/c" }, 201);
    if (path.endsWith("/git/refs/heads/main") && method === "PATCH") return json({ object: { sha: "new-commit" } });
    if (path.endsWith("/git/refs") && method === "POST") return json({ object: { sha: "new-commit" } }, 201);
    if (path.endsWith("/pulls") && method === "POST") {
      if (opts.failAt === "pr") return json({ message: "pr boom" }, 422);
      return json({ number: 7, html_url: "https://github.com/pr/7" }, 201);
    }
    return json({ message: `unexpected ${method} ${path}` }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

const baseInput = { token: "gho_user", repoFullName: REPO, message: "Edit docs/index.md", files: [{ path: "docs/index.md", content: "# New\n" }] };

describe("commitFiles", () => {
  it.each(['pr', 'direct'] as const)('reports unchanged content without creating a commit or PR in %s mode', async mode => {
    const gh = mockGitHub({ unchanged: true });
    const result = await commitFiles({ ...baseInput, mode });
    expect(result).toEqual({ ok: true, unchanged: true, branch: 'main', commitSha: 'head-sha' });
    expect(gh.calls.some(call => call.path.endsWith('/pulls') || call.path.endsWith('/git/refs') || (call.path.endsWith('/git/commits') && call.method === 'POST') || call.method === 'PATCH')).toBe(false);
  });
  it.each([403, 404, 503])('preserves source lookup failure %s without reporting a version conflict', async sourceStatus => {
    const gh = mockGitHub({ sourceStatus });
    const result = await commitFiles({ ...baseInput, mode: 'pr', expectedFiles: { 'docs/index.md': 'expected-sha' } });
    expect(result.errorCode).toBe('upstream_error');
    expect(result.error).toContain(String(sourceStatus));
    expect(gh.calls.some(call => call.method !== 'GET')).toBe(false);
  });
  it('checks source against the exact parent commit and distinguishes a stale proposal', async () => {
    const gh = mockGitHub({ sourceSha: 'changed-sha' });
    const result = await commitFiles({ ...baseInput, mode: 'pr', expectedFiles: { 'docs/index.md': 'expected-sha' } });
    expect(result.errorCode).toBe('source_conflict');
    expect(gh.calls.find(call => call.path.includes('/contents/'))?.query).toBe('?ref=head-sha');
    expect(gh.calls.some(call => call.method !== 'GET')).toBe(false);
  });
  it('creates binary blobs without UTF-8 re-encoding', async () => {
    const gh = mockGitHub();
    const binary = btoa(String.fromCharCode(0, 128, 255));
    const result = await commitFiles({ ...baseInput, mode: 'direct', files: [{ path: 'docs/audio/sample.wav', content: binary, encoding: 'base64' }] });
    expect(result.ok).toBe(true);
    expect(gh.calls.find(call => call.path.endsWith('/git/blobs'))?.body).toEqual({ content: binary, encoding: 'base64' });
  });
  it("opens a PR in pr mode (branch + pull request)", async () => {
    const gh = mockGitHub();
    const result = await commitFiles({ ...baseInput, mode: "pr" });
    expect(result.ok).toBe(true);
    expect(result.prNumber).toBe(7);
    expect(result.prUrl).toBe("https://github.com/pr/7");
    expect(result.branch).toMatch(/^fds\/edit-/);
    expect(gh.calls.some((c) => c.method === "POST" && c.path.endsWith("/git/refs"))).toBe(true);
    expect(gh.calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toBe(true);
    expect(gh.calls.some((c) => c.path.endsWith("/git/refs/heads/main"))).toBe(false);
  });

  it("commits straight to the base branch in direct mode (no PR)", async () => {
    const gh = mockGitHub();
    const result = await commitFiles({ ...baseInput, mode: "direct" });
    expect(result.ok).toBe(true);
    expect(result.branch).toBe("main");
    expect(result.prNumber).toBeUndefined();
    expect(gh.calls.some((c) => c.method === "PATCH" && c.path.endsWith("/git/refs/heads/main"))).toBe(true);
    expect(gh.calls.some((c) => c.path.endsWith("/pulls"))).toBe(false);
  });

  it("reports a missing base branch", async () => {
    mockGitHub({ failAt: "ref" });
    const result = await commitFiles({ ...baseInput, mode: "pr" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not resolve main/);
  });

  it("reports a failed tree without committing", async () => {
    const gh = mockGitHub({ failAt: "tree" });
    const result = await commitFiles({ ...baseInput, mode: "direct" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Tree create failed/);
    expect(gh.calls.some((c) => c.path.endsWith("/git/commits") && c.method === "POST")).toBe(false);
  });

  it("surfaces a PR creation failure", async () => {
    const result = await (mockGitHub({ failAt: "pr" }), commitFiles({ ...baseInput, mode: "pr" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/PR create failed/);
  });
});
