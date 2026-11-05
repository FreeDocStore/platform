import type { Hono } from "hono";
import { type Env, type Variables } from "../types";
import { requireSession } from "../lib/session";
import { publishKb, type PublishFile } from "../publish";
import { commitFiles } from "../github";
import { MAX_AUDIO_BYTES, validateAudio } from '../audio';
import { bodyLimit } from 'hono/body-limit';
import { objectBody, stringField, validOwner, validRepo, validPath, validBranch, validDomain } from '../lib/validation';

type App = Hono<{ Bindings: Env; Variables: Variables }>;

export function registerPublishRoutes(app: App) {
  app.post('/api/audio', bodyLimit({ maxSize: Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4096, onError: c => c.json({ error: 'Audio exceeds 12 MiB' }, 413) }), async c => {
    const session = requireSession(c);
    if (!session.githubAccessToken) return c.json({ error: 'Sign in with GitHub to propose narration.' }, 403);
    let audio;
    try { audio = await validateAudio(await c.req.json()); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Invalid narration' }, 400); }
    const result = await commitFiles({ token: session.githubAccessToken, repoFullName: audio.repo, baseBranch: audio.branch, mode: 'pr',
      message: `Add narration for ${audio.sourcePath}`, files: audio.files,
      expectedFiles: { [audio.sourcePath]: audio.sourceSha },
      prBody: `Locally generated English narration for ${audio.sourcePath}. Source blob: ${audio.sourceSha}. Review the WAV recording and metadata before merging. Install the current FreeDocStore reader in the publishing workflow to enable playback.`,
    });
    return c.json(result, result.ok ? 200 : result.errorCode === 'source_conflict' ? 409 : 502);
  });
  app.post("/api/publish", bodyLimit({ maxSize: 8 * 1024 * 1024, onError: c => c.json({ error: 'Publish request exceeds 8 MiB' }, 413) }), async (c) => {
    const session = requireSession(c);
    if (!session.githubAccessToken) {
      return c.json({ error: "Publishing requires signing in with GitHub (repo access)." }, 403);
    }
    let body: Record<string, unknown>;
    let title: string, slug: string, owner: string, customDomain: string, description: string;
    let files: PublishFile[];
    try {
      body = objectBody(await c.req.json());
      title = stringField(body, 'title');
      slug = stringField(body, 'slug').toLowerCase();
      owner = stringField(body, 'owner', c.env.GITHUB_ORG);
      customDomain = stringField(body, 'customDomain').toLowerCase();
      description = stringField(body, 'description');
      if (body.visibility !== undefined && body.visibility !== 'public') throw new Error('FreeDocStore publishes public knowledge bases only. Private KBs belong in ProDocStore.');
      if (!title || title.length > 200) throw new Error('Title must contain 1-200 characters');
      if (!/^[a-z][a-z0-9-]{1,57}$/.test(slug)) throw new Error('Slug must contain 2-58 lowercase letters, digits or dashes and start with a letter');
      if (!validOwner(owner)) throw new Error('Invalid GitHub owner');
      if (customDomain && !validDomain(customDomain)) throw new Error('Custom domain must be a valid hostname');
      if (!Array.isArray(body.files) || !body.files.length || body.files.length > 100) throw new Error('files must contain 1-100 entries');
      files = body.files as PublishFile[];
      const seen = new Set<string>();
      for (const file of files) {
        if (!file || typeof file.path !== 'string' || typeof file.content !== 'string' || !validPath(file.path)) throw new Error('Each file needs a valid relative path and text content');
        if (seen.has(file.path)) throw new Error(`Duplicate file path: ${file.path}`);
        seen.add(file.path);
        if (new TextEncoder().encode(file.content).length > 512 * 1024) throw new Error(`File too large: ${file.path}`);
        if (file.path.startsWith('site/') || /\.html?$/i.test(file.path)) throw new Error('Publish Zensical source files, not generated HTML or site output');
      }
      for (const path of ['zensical.toml', 'docs/index.md', '.github/workflows/deploy.yml']) if (!seen.has(path)) throw new Error(`files must include ${path}`);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Invalid publish request' }, 400); }
    const result = await publishKb({
      title,
      slug,
      owner,
      customDomain: customDomain || undefined,
      description: description || undefined,
      files,
      userToken: session.githubAccessToken,
      platformToken: c.env.GITHUB_TOKEN,
      org: c.env.GITHUB_ORG,
    });
    return c.json(result, result.ok ? 200 : 502);
  });

  app.post("/api/edit", bodyLimit({ maxSize: 4 * 1024 * 1024, onError: c => c.json({ error: 'Edit request exceeds 4 MiB' }, 413) }), async (c) => {
    const session = requireSession(c);
    if (!session.githubAccessToken) {
      return c.json({ error: "Editing requires signing in with GitHub (repo access)." }, 403);
    }
    let repo: string, path: string, content: string, message: string, branch: string;
    let mode: 'direct' | 'pr';
    let expectedSourceSha: string | undefined;
    try {
      const body = objectBody(await c.req.json());
      repo = stringField(body, 'repo'); path = stringField(body, 'path');
      if (typeof body.content !== 'string' || !body.content.trim()) throw new Error('content is required');
      content = body.content;
      message = stringField(body, 'message', `Update ${path} via FreeDocStore`).slice(0, 120);
      branch = stringField(body, 'branch', 'main');
      if (!validRepo(repo)) throw new Error('repo must be owner/name');
      if (!validPath(path)) throw new Error('Invalid file path');
      if (!validBranch(branch)) throw new Error('Invalid branch');
      if (new TextEncoder().encode(content).length > 512 * 1024) throw new Error('content too large');
      if (body.mode !== undefined && body.mode !== 'direct' && body.mode !== 'pr') throw new Error('Invalid apply mode');
      mode = body.mode === 'direct' ? 'direct' : 'pr';
      expectedSourceSha = body.expectedSourceSha === undefined ? undefined : stringField(body, 'expectedSourceSha');
      if (expectedSourceSha !== undefined && !/^[0-9a-f]{40}$/.test(expectedSourceSha)) throw new Error('Invalid expected source version');
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Invalid edit request' }, 400); }
    const result = await commitFiles({
      token: session.githubAccessToken,
      repoFullName: repo,
      message,
      files: [{ path, content }],
      baseBranch: branch,
      mode,
      prTitle: message,
      prBody: `Proposed through the FreeDocStore console by ${session.user.login}.`,
      expectedFiles: expectedSourceSha ? { [path]: expectedSourceSha } : undefined,
    });
    return c.json(result, result.ok ? 200 : result.errorCode === 'source_conflict' ? 409 : 502);
  });
}
