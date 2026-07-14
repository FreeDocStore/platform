import type { Hono } from "hono";
import { type Env, type Variables } from "../types";
import { requireSession } from "../lib/session";
import { publishKb, type PublishFile } from "../publish";
import { commitFiles } from "../github";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

export function registerPublishRoutes(app: App) {
  app.post("/api/publish", async (c) => {
    const session = requireSession(c);
    if (!session.githubAccessToken) {
      return c.json({ error: "Publishing requires signing in with GitHub (repo access)." }, 403);
    }
    const body: {
      title?: string;
      slug?: string;
      owner?: string;
      customDomain?: string;
      description?: string;
      visibility?: string;
      files?: PublishFile[];
    } = await c.req.json().catch(() => ({}));
    if (body.visibility === "private") {
      return c.json({ error: "FreeDocStore publishes public knowledge bases only. Private KBs belong in ProDocStore." }, 400);
    }
    const title = (body.title ?? "").trim();
    const slug = (body.slug ?? "").trim().toLowerCase();
    const owner = (body.owner ?? c.env.GITHUB_ORG).trim();
    const files = Array.isArray(body.files) ? body.files : [];
    if (!title) return c.json({ error: "Missing title" }, 400);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return c.json({ error: "Slug must be lowercase letters, digits, and dashes" }, 400);
    if (!files.length || files.length > 100) return c.json({ error: "files must contain 1-100 entries" }, 400);
    for (const file of files) {
      if (typeof file?.path !== "string" || typeof file?.content !== "string") return c.json({ error: "Each file needs path and content" }, 400);
      if (file.path.startsWith("/") || file.path.split("/").includes("..")) return c.json({ error: `Invalid file path: ${file.path}` }, 400);
      if (file.content.length > 512 * 1024) return c.json({ error: `File too large: ${file.path}` }, 400);
    }
    if (!files.some((file) => file.path === ".github/workflows/deploy.yml")) {
      return c.json({ error: "files must include .github/workflows/deploy.yml" }, 400);
    }
    const result = await publishKb({
      title,
      slug,
      owner,
      customDomain: body.customDomain?.trim() || undefined,
      description: body.description?.trim() || undefined,
      files,
      userToken: session.githubAccessToken,
      platformToken: c.env.GITHUB_TOKEN,
      org: c.env.GITHUB_ORG,
    });
    return c.json(result, result.ok ? 200 : 502);
  });

  app.post("/api/edit", async (c) => {
    const session = requireSession(c);
    if (!session.githubAccessToken) {
      return c.json({ error: "Editing requires signing in with GitHub (repo access)." }, 403);
    }
    const body: {
      repo?: string;
      path?: string;
      content?: string;
      message?: string;
      mode?: string;
      branch?: string;
    } = await c.req.json().catch(() => ({}));
    const repo = (body.repo ?? "").trim();
    const path = (body.path ?? "").trim();
    const content = typeof body.content === "string" ? body.content : "";
    const mode = body.mode === "direct" ? "direct" : "pr";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return c.json({ error: "repo must be owner/name" }, 400);
    if (!path || path.startsWith("/") || path.split("/").includes("..")) return c.json({ error: `Invalid path: ${path}` }, 400);
    if (!content.trim()) return c.json({ error: "content is required" }, 400);
    if (content.length > 512 * 1024) return c.json({ error: "content too large" }, 400);
    const message = (body.message ?? `Update ${path} via FreeDocStore`).slice(0, 120);
    const result = await commitFiles({
      token: session.githubAccessToken,
      repoFullName: repo,
      message,
      files: [{ path, content }],
      baseBranch: body.branch?.trim() || "main",
      mode,
      prTitle: message,
      prBody: `Proposed through the FreeDocStore console by ${session.user.login}.`,
    });
    return c.json(result, result.ok ? 200 : 502);
  });
}
