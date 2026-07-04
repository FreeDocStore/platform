// Source-file fetching shared by both adapters. Kept separate from the
// OpenAI adapter so the Claude adapter imports it from a neutral module
// rather than reaching into its sibling.

import type { PendingEditProposal, Settings } from "../types";
import { GitHubClient } from "../lib/github";
import { getTask } from "../lib/tasks";
import { loadPendingProposal } from "../lib/proposals";

// Extensions tried (in order) when the resolved source path 404s. Covers
// the Markdown family static generators build from. The first hit wins and
// its path is returned so downstream commit/diff target the real file.
const SOURCE_FALLBACK_EXTS = [".md", ".mdx", ".markdown", ".html"];

/**
 * Fetch the source file for a page, tolerating a path whose extension
 * doesn't match the actual source. Sites that emit `<meta name="source-path">`
 * resolve on the first try; sites that don't (so we guessed `docs/foo.html`
 * from the clean URL) fall back to sibling extensions - this is what makes
 * editing work on a Zensical/MkDocs site whose source is `docs/foo.md`.
 * Returns the RESOLVED path so the commit lands on the right file.
 */
export async function fetchSourceFile(
  gh: GitHubClient,
  owner: string,
  repo: string,
  path: string,
): Promise<{ content: string; sha: string; path: string }> {
  try {
    const f = await gh.getFile(owner, repo, path);
    return { content: f.content, sha: f.sha, path };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/404/.test(msg)) throw err;
    const dot = path.lastIndexOf(".");
    const stem = dot >= 0 ? path.slice(0, dot) : path;
    const curExt = dot >= 0 ? path.slice(dot) : "";
    for (const ext of SOURCE_FALLBACK_EXTS) {
      if (ext === curExt) continue;
      try {
        const f = await gh.getFile(owner, repo, stem + ext);
        return { content: f.content, sha: f.sha, path: stem + ext };
      } catch {
        // try the next extension; rethrow the original 404 if none hit.
      }
    }
    throw err;
  }
}

/**
 * The uncommitted DRAFT backing an edit thread, if any: the task's pending
 * proposal that hasn't been applied yet. A follow-up turn should revise this
 * draft rather than the committed repo file - the draft holds the not-yet-
 * pushed content, and for a brand-new page there IS no committed file (editing
 * it 404s, which used to dead-end the thread with "doesn't exist yet"). Returns
 * null when the task has no live proposal (never proposed, or already
 * applied/cancelled - loadPendingProposal returns null once it's consumed).
 */
export async function loadTaskDraft(taskId: string | undefined): Promise<PendingEditProposal | null> {
  if (!taskId) return null;
  const task = await getTask(taskId);
  if (!task?.proposalId) return null;
  const p = await loadPendingProposal(task.proposalId);
  return p && p.kind === "edit" ? p : null;
}

export async function tryBuildGitHubClient(settings: Settings): Promise<GitHubClient | null> {
  const hasApp = !!settings.claude?.githubApp?.accessToken;
  const hasPat = !!settings.claude?.githubToken;
  if (!hasApp && !hasPat) return null;
  return GitHubClient.fromSettings(settings);
}
