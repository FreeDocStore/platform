import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWriteTools } from "../tools/write";
import { registerAccountTools } from "../tools/account";
import type { Env, McpProps } from "../tools/helpers";

// --- fakes ------------------------------------------------------------------

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: string; text: string }> }>;

/** Capture tools registered via agent.server.tool(name, desc, schema, handler). */
function captureTools(register: (agent: any) => void, env: Env, props: McpProps) {
  const handlers: Record<string, ToolHandler> = {};
  const server = { tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => { handlers[name] = handler; } };
  register({ server, env, props });
  return handlers;
}

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
    async put(key: string, value: string) { store.set(key, String(value)); },
    async delete(key: string) { store.delete(key); },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true as const, cursor: undefined };
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const REGISTRY_URL = "https://registry.test/registry.json";

function textOf(res: { content: Array<{ text: string }> }): string {
  return res.content.map((c) => c.text).join("\n");
}

/** Routes registry + GitHub REST calls; records every requested URL. */
function stubNetwork(opts: { registry?: unknown } = {}) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    urls.push(`${method} ${url}`);
    if (url === REGISTRY_URL) return json(opts.registry ?? { knowledge_bases: [] });
    const path = new URL(url).pathname;
    if (path.endsWith("/git/ref/heads/main") && method === "GET") return json({ object: { sha: "head-sha" } });
    if (path.includes("/git/commits/") && method === "GET") return json({ tree: { sha: "base-tree" } });
    if (path.endsWith("/git/blobs") && method === "POST") return json({ sha: "blob-1" }, 201);
    if (path.endsWith("/git/trees") && method === "POST") return json({ sha: "new-tree" }, 201);
    if (path.endsWith("/git/commits") && method === "POST") return json({ sha: "commit-1", html_url: "https://github.com/c" }, 201);
    if (path.endsWith("/git/refs/heads/main") && method === "PATCH") return json({ object: { sha: "commit-1" } });
    if (path.endsWith("/git/refs") && method === "POST") return json({ object: { sha: "commit-1" } }, 201);
    if (path.endsWith("/pulls") && method === "POST") return json({ number: 3, html_url: "https://github.com/pr/3" }, 201);
    return json({ message: `unexpected ${method} ${path}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { urls, hitGitHub: () => urls.some((u) => u.includes("api.github.com")) };
}

const baseEnv = (kv: ReturnType<typeof memKV>) => ({
  REGISTRY_URL,
  GITHUB_ORG: "FreeDocStore",
  DEFAULT_DOMAIN: "freedocstore.online",
  FDS_API_KV: kv,
} as unknown as Env);

const writeProps: McpProps = { userId: "github_42", login: "octo", provider: "github", scopes: ["read", "write"], githubAccessToken: "gho_x" };

const auditKeys = (kv: ReturnType<typeof memKV>) => [...kv._store.keys()].filter((k) => k.includes(":audit:"));

afterEach(() => vi.unstubAllGlobals());

// --- update_files -----------------------------------------------------------

describe("update_files", () => {
  const args = { repo: "my-kb", message: "Edit docs", files: [{ path: "docs/index.md", content: "# Hi\n" }] };

  it("dry_run returns a plan and never calls GitHub", async () => {
    const net = stubNetwork();
    const kv = memKV();
    const tools = captureTools(registerWriteTools, baseEnv(kv), writeProps);
    const res = await tools.update_files({ ...args, dry_run: true });
    const text = textOf(res);
    expect(text).toMatch(/Dry run/);
    expect(text).toContain("docs/index.md");
    expect(net.hitGitHub()).toBe(false);
    expect(auditKeys(kv)).toHaveLength(0);
  });

  it("direct mode without confirm is blocked and writes nothing", async () => {
    const net = stubNetwork();
    const kv = memKV();
    const tools = captureTools(registerWriteTools, baseEnv(kv), writeProps);
    const res = await tools.update_files({ ...args, mode: "direct" });
    expect(textOf(res)).toMatch(/requires confirm: true/);
    expect(net.hitGitHub()).toBe(false);
    expect(auditKeys(kv)).toHaveLength(0);
  });

  it("direct mode with confirm commits and writes an audit entry", async () => {
    stubNetwork();
    const kv = memKV();
    const tools = captureTools(registerWriteTools, baseEnv(kv), writeProps);
    const res = await tools.update_files({ ...args, mode: "direct", confirm: true });
    expect(textOf(res)).toMatch(/Committed directly/);
    const keys = auditKeys(kv);
    expect(keys).toHaveLength(1);
    const entry = JSON.parse(kv._store.get(keys[0])!);
    expect(entry).toMatchObject({ tool: "update_files", action: "commit", target: "FreeDocStore/my-kb", userId: "github_42" });
  });

  it("pr mode (default) opens a PR and logs an open_pr audit entry", async () => {
    stubNetwork();
    const kv = memKV();
    const tools = captureTools(registerWriteTools, baseEnv(kv), writeProps);
    const res = await tools.update_files(args);
    expect(textOf(res)).toMatch(/Opened proposal PR #3/);
    const keys = auditKeys(kv);
    expect(keys).toHaveLength(1);
    expect(JSON.parse(kv._store.get(keys[0])!)).toMatchObject({ tool: "update_files", action: "open_pr" });
  });

  it("rejects a session without the write scope", async () => {
    stubNetwork();
    const kv = memKV();
    const readOnly: McpProps = { ...writeProps, scopes: ["read"] };
    const tools = captureTools(registerWriteTools, baseEnv(kv), readOnly);
    await expect(tools.update_files(args)).rejects.toThrow(/write scope/);
  });
});

// --- account mutators -------------------------------------------------------

describe("account draft mutators", () => {
  it("create_workspace_draft persists a draft and logs an audit entry", async () => {
    const kv = memKV();
    const tools = captureTools(registerAccountTools, baseEnv(kv), writeProps);
    const res = await tools.create_workspace_draft({ title: "My KB", prompt: "cover things" });
    expect(textOf(res)).toMatch(/Created FreeDocStore workspace draft/);
    // draft saved under the user's workspace key
    expect([...kv._store.keys()].some((k) => k.endsWith("fds:kbs:v1"))).toBe(true);
    const keys = auditKeys(kv);
    expect(keys).toHaveLength(1);
    expect(JSON.parse(kv._store.get(keys[0])!)).toMatchObject({ tool: "create_workspace_draft", action: "create_draft" });
  });

  it("create_sample_knowledge_base logs an audit entry", async () => {
    const kv = memKV();
    const tools = captureTools(registerAccountTools, baseEnv(kv), writeProps);
    await tools.create_sample_knowledge_base({});
    const keys = auditKeys(kv);
    expect(keys).toHaveLength(1);
    expect(JSON.parse(kv._store.get(keys[0])!)).toMatchObject({ tool: "create_sample_knowledge_base" });
  });

  it("rejects a session without the write scope", async () => {
    const kv = memKV();
    const readOnly: McpProps = { ...writeProps, scopes: ["read"] };
    const tools = captureTools(registerAccountTools, baseEnv(kv), readOnly);
    await expect(tools.create_workspace_draft({ title: "x", prompt: "y" })).rejects.toThrow(/write scope/);
  });
});
