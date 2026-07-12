import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findKnowledgeBase,
  getDeployStatus,
  listRepoFiles,
  readRepoFile,
  updateRepoFiles,
  type Registry,
} from "./github";

const REPO = "FreeDocStore/true-non-profit";

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe("findKnowledgeBase", () => {
  const registry: Registry = {
    knowledge_bases: [
      { id: "a", title: "A", engine: "zensical", source: { repo: "o/a" } },
      { id: "b", title: "B", engine: "zensical", source: { repo: "o/b" } },
    ],
  };
  it("finds by id", () => {
    expect(findKnowledgeBase(registry, "b")?.title).toBe("B");
  });
  it("returns undefined for unknown id and empty registry", () => {
    expect(findKnowledgeBase(registry, "z")).toBeUndefined();
    expect(findKnowledgeBase({}, "a")).toBeUndefined();
  });
});

describe("readRepoFile", () => {
  it("decodes base64 file contents", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ content: b64("# Hello\n"), encoding: "base64" })));
    expect(await readRepoFile(REPO, "docs/index.md", "main")).toBe("# Hello\n");
  });
  it("returns null for a non-base64 or missing file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Not Found" }, 404)));
    expect(await readRepoFile(REPO, "nope.md")).toBeNull();
  });
});

describe("listRepoFiles", () => {
  it("returns blobs and trees from the recursive tree", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/git/ref/heads/main")) return json({ object: { sha: "head" } });
      if (path.includes("/git/trees/")) {
        return json({ tree: [
          { path: "docs", type: "tree" },
          { path: "docs/index.md", type: "blob", size: 12 },
        ] });
      }
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const files = await listRepoFiles(REPO);
    expect(files.map((f) => f.path)).toEqual(["docs", "docs/index.md"]);
  });
  it("returns [] when the branch ref is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "no ref" }, 404)));
    expect(await listRepoFiles(REPO)).toEqual([]);
  });
});

describe("getDeployStatus", () => {
  it("maps workflow runs to compact rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      workflow_runs: [
        { name: "Deploy", conclusion: "success", status: "completed", updated_at: "t", html_url: "u", head_sha: "abcdef1234" },
      ],
    })));
    const runs = await getDeployStatus(REPO);
    expect(Array.isArray(runs)).toBe(true);
    expect((runs as any[])[0]).toMatchObject({ name: "Deploy", status: "success", sha: "abcdef1" });
  });
  it("returns an error object on a failed API call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 500)));
    expect(await getDeployStatus(REPO)).toHaveProperty("error");
  });
});

interface MockOpts {
  failAt?: "ref" | "tree" | "pr";
}
function mockGitHub(opts: MockOpts = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (path.endsWith("/git/ref/heads/main") && method === "GET") {
      return opts.failAt === "ref" ? json({ message: "no ref" }, 404) : json({ object: { sha: "head-sha" } });
    }
    if (path.includes("/git/commits/") && method === "GET") return json({ tree: { sha: "base-tree" } });
    if (path.endsWith("/git/blobs") && method === "POST") return json({ sha: "blob-1" }, 201);
    if (path.endsWith("/git/trees") && method === "POST") {
      return opts.failAt === "tree" ? json({ message: "boom" }, 500) : json({ sha: "new-tree" }, 201);
    }
    if (path.endsWith("/git/commits") && method === "POST") return json({ sha: "commit-1", html_url: "https://github.com/c" }, 201);
    if (path.endsWith("/git/refs/heads/main") && method === "PATCH") return json({ object: { sha: "commit-1" } });
    if (path.endsWith("/git/refs") && method === "POST") return json({ object: { sha: "commit-1" } }, 201);
    if (path.endsWith("/pulls") && method === "POST") {
      return opts.failAt === "pr" ? json({ message: "pr boom" }, 422) : json({ number: 3, html_url: "https://github.com/pr/3" }, 201);
    }
    return json({ message: `unexpected ${method} ${path}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

const editInput = { token: "gho_user", repoFullName: REPO, message: "Edit", files: [{ path: "docs/index.md", content: "# New\n" }] };

describe("updateRepoFiles", () => {
  it("opens a PR in pr mode", async () => {
    const gh = mockGitHub();
    const result = await updateRepoFiles({ ...editInput, mode: "pr" });
    expect(result.ok).toBe(true);
    expect(result.prNumber).toBe(3);
    expect(result.branch).toMatch(/^fds\/mcp-/);
    expect(gh.calls.some((c) => c.path.endsWith("/pulls"))).toBe(true);
  });
  it("commits directly in direct mode", async () => {
    const gh = mockGitHub();
    const result = await updateRepoFiles({ ...editInput, mode: "direct" });
    expect(result.ok).toBe(true);
    expect(result.branch).toBe("main");
    expect(gh.calls.some((c) => c.method === "PATCH")).toBe(true);
    expect(gh.calls.some((c) => c.path.endsWith("/pulls"))).toBe(false);
  });
  it("stages deletions as null-sha tree entries", async () => {
    const gh = mockGitHub();
    await updateRepoFiles({ ...editInput, deletePaths: ["docs/old.md"], mode: "direct" });
    const tree = gh.calls.find((c) => c.path.endsWith("/git/trees"))!;
    expect(tree.body.tree).toContainEqual({ path: "docs/old.md", mode: "100644", type: "blob", sha: null });
  });
  it("reports a missing base branch, a failed tree, and a failed PR", async () => {
    mockGitHub({ failAt: "ref" });
    expect((await updateRepoFiles({ ...editInput, mode: "pr" })).error).toMatch(/Could not resolve main/);
    mockGitHub({ failAt: "tree" });
    expect((await updateRepoFiles({ ...editInput, mode: "direct" })).error).toMatch(/Tree create failed/);
    mockGitHub({ failAt: "pr" });
    expect((await updateRepoFiles({ ...editInput, mode: "pr" })).error).toMatch(/PR create failed/);
  });
});
