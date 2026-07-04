// Applying a proposal: the actual commit/PR flow, plus advancing the linked
// board task. Called from the background's APPLY_PROPOSAL handler. Split out of
// proposal-engine.ts.

import type { ChatMessage, PendingProposal, TaskStatus } from "../types";
import { mirrorTaskToRepo, mutateTask } from "../lib/tasks";
import { GitHubClient } from "../lib/github";
import { branchName } from "../lib/edits";
import { parseRepoKey } from "../lib/text";
import { removePendingProposal } from "../lib/proposals";
import { MEMORY_PATH, invalidateCachesAfterApply } from "./repo-context";
import { NAV_PATH } from "./proposal-shared";

/**
 * Move a proposal's board task forward after a successful Apply. No-op for
 * non-edit proposals or proposals with no linked task (older proposals,
 * nav/memory). Records the PR/commit and appends a thread note. The repo
 * mirror is best-effort so a failed mirror never breaks Apply.
 */
async function advanceTaskOnApply(
  proposal: PendingProposal,
  gh: GitHubClient,
  status: TaskStatus,
  links: { pr?: { url: string; number: number }; commit?: { url: string; sha: string } },
): Promise<void> {
  if (proposal.kind !== "edit" || !proposal.taskId) return;
  // Board bookkeeping is best-effort: by the time we're here the commit/PR has
  // already landed and IS the source of truth. A storage hiccup here must never
  // surface as "Apply failed" for a change that actually succeeded, so the
  // whole body is guarded.
  try {
    const now = Date.now();
    const note = links.pr
      ? `Opened PR #${links.pr.number}: ${links.pr.url}`
      : links.commit
        ? `Pushed: ${links.commit.url}`
        : "Applied.";
    // Read-modify-write INSIDE the serialized queue (mutateTask) so a
    // concurrent task write can't clobber the status/links we're recording.
    const updated = await mutateTask(proposal.taskId, (t) => ({
      ...t,
      status,
      pr: links.pr ?? t.pr,
      commit: links.commit ?? t.commit,
      conversation: [...t.conversation, { role: "assistant", content: note, timestamp: now }],
      updatedAt: now,
    }));
    if (!updated) return;
    const parsed = parseRepoKey(updated.repo);
    if (parsed) {
      try {
        await mirrorTaskToRepo(gh, parsed.owner, parsed.name, updated);
      } catch {
        // best-effort
      }
    }
  } catch {
    // Swallow: the commit already succeeded; don't fail Apply over bookkeeping.
  }
}

/**
 * Take a stored PendingProposal and run the actual commit/PR flow. Called from
 * the background's APPLY_PROPOSAL handler. Removes the proposal from session
 * storage on success or on terminal failure (a stale-SHA 409 keeps the proposal
 * so the user can retry).
 */
export async function applyPendingProposal(
  proposal: PendingProposal,
  gh: GitHubClient,
): Promise<ChatMessage> {
  const { owner, repo, summary, commitMode } = proposal;
  // Memory has no rationale field - it's a one-line entry, the entry IS
  // the description. Edit/nav have an optional rationale used as PR body.
  const rationale = proposal.kind === "memory" ? "" : (proposal.rationale ?? "");
  const commitMsg = rationale ? `${summary}\n\n${rationale}` : summary;
  const path =
    proposal.kind === "edit" ? proposal.path
    : proposal.kind === "memory" ? MEMORY_PATH
    : (proposal.path ?? NAV_PATH); // nav: mkdocs.yml on generator sites, else nav.json
  const newContent =
    proposal.kind === "edit" ? proposal.editedContent
    : proposal.newContent;
  // edit/nav always have a SHA (we just fetched the file). memory's SHA
  // is null when MEMORY.md doesn't exist yet - GitHub PUT then creates.
  const sha = proposal.fileSha;

  try {
    const base = await gh.getDefaultBranch(owner, repo);

    if (commitMode === "direct") {
      const commit = await gh.updateFile(owner, repo, path, newContent, sha, base.name, commitMsg);
      await removePendingProposal(proposal.proposalId);
      // Invalidate caches so the NEXT chat turn sees the just-applied
      // change. Without this, memoryCache holds the pre-apply MEMORY.md
      // for 5 min and the model thinks the entry it just added doesn't
      // exist; activityCache hides the new commit for the same window.
      invalidateCachesAfterApply(proposal, owner, repo, gh);
      // Direct push is live immediately -> task is "deployed".
      await advanceTaskOnApply(proposal, gh, "deployed", {
        commit: { url: commit.html_url, sha: commit.sha },
      });
      return {
        role: "assistant",
        content: `✅ Pushed to ${base.name} (${path}): ${commit.html_url}\n\n${summary}`,
        attachment: { kind: "commit", data: { url: commit.html_url, sha: commit.sha } },
      };
    }

    const branch = branchName(summary);
    await gh.createBranch(owner, repo, branch, base.sha);
    await gh.updateFile(owner, repo, path, newContent, sha, branch, commitMsg);
    const pr = await gh.createPullRequest(owner, repo, summary, rationale ?? "", branch, base.name);
    await removePendingProposal(proposal.proposalId);
    invalidateCachesAfterApply(proposal, owner, repo, gh);
    // PR opened -> task moves to "in_review".
    await advanceTaskOnApply(proposal, gh, "in_review", {
      pr: { url: pr.html_url, number: pr.number },
    });
    return {
      role: "assistant",
      content: `✅ PR opened (${path}): ${pr.html_url}\n\n${summary}`,
      attachment: { kind: "pr", data: { url: pr.html_url, number: pr.number } },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 409 = stale SHA. Keep the proposal so the user can re-preview
    // (or so we can later add a re-fetch-and-retry). All other errors
    // also keep the proposal - cleaning it up only on success means the
    // user can hit Apply again after fixing the underlying issue.
    return { role: "assistant", content: `Apply failed: ${msg}` };
  }
}
