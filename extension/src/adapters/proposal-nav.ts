// Nav proposals: pick the site's nav config file, build a before/after preview
// of the menu change. Split out of proposal-engine.ts.

import type { ChatMessage, CommitMode, PendingProposal } from "../types";
import type { NavProposal } from "../lib/openai";
import { GitHubClient } from "../lib/github";
import { parseNavConfig } from "../resolver";
import { applyMkdocsNav } from "../lib/mkdocs-nav";
import { loadPendingProposal, savePendingProposal } from "../lib/proposals";
import { NAV_PATH } from "./proposal-shared";

/**
 * Pick the nav config file for this site. Hand-authored HTML sites use
 * docs/nav.json; generator sites (MkDocs/Material) keep their menu in
 * mkdocs.yml. The target is chosen HERE, from what actually exists in the
 * repo - never from a model-supplied path - so a nav write can only ever land
 * on a real nav config, keeping edit_file's docs/-only clamp meaningful.
 */
async function resolveNavTarget(
  gh: GitHubClient,
  owner: string,
  repo: string,
): Promise<{ path: string; format: "navjson" | "mkdocs"; file: { content: string; sha: string } | null }> {
  const navJson = await gh.getFileOrNull(owner, repo, NAV_PATH);
  if (navJson) return { path: NAV_PATH, format: "navjson", file: navJson };
  for (const p of ["mkdocs.yml", "mkdocs.yaml"]) {
    const f = await gh.getFileOrNull(owner, repo, p);
    if (f) return { path: p, format: "mkdocs", file: f };
  }
  // Nothing found: default to creating docs/nav.json (legacy behaviour).
  return { path: NAV_PATH, format: "navjson", file: null };
}

/**
 * Build a PendingNavProposal from the model's NavProposal. Fetches the current
 * nav config so the preview UI can show a before/after diff. Validates shape;
 * returns an error chat message if invalid.
 */
export async function buildNavProposalPreview(
  gh: GitHubClient,
  owner: string,
  repo: string,
  proposal: NavProposal,
  commitMode: CommitMode,
): Promise<ChatMessage> {
  const target = await resolveNavTarget(gh, owner, repo);

  let currentContent: string;
  let newContent: string;
  let fileSha: string | null;

  if (target.format === "mkdocs") {
    // Generator site: rewrite ONLY the nav: block in mkdocs.yml, preserving the
    // rest of the file. applyMkdocsNav is the sole writer of mkdocs.yml.
    // Validate the shape the SAME way the nav.json branch does BEFORE
    // serializing: without this, serializeMkdocsNav silently drops an item that
    // has neither href nor children, and throws a raw TypeError on a child with
    // no href (toMkdocsPath(undefined)). Reuse parseNavConfig on {items}.
    if (!parseNavConfig(JSON.stringify({ items: proposal.items }))) {
      return {
        role: "assistant",
        content:
          "Model returned an invalid nav shape (missing labels, bad children, " +
          "or items with neither href nor children). Try a more specific prompt.",
      };
    }
    const file = target.file!; // mkdocs.yml existed to be picked
    currentContent = file.content;
    newContent = applyMkdocsNav(file.content, proposal.items);
    fileSha = file.sha;
  } else {
    // HTML site: deterministic nav.json so diffs show only the real change.
    const newConfig: Record<string, unknown> = { items: proposal.items };
    if (proposal.navSkip?.length) newConfig.navSkip = proposal.navSkip;
    newContent = JSON.stringify(newConfig, null, 2) + "\n";
    if (!parseNavConfig(newContent)) {
      return {
        role: "assistant",
        content:
          "Model returned an invalid nav shape (missing labels, bad children, " +
          "or items with neither href nor children). Try a more specific prompt.",
      };
    }
    // resolveNavTarget returns file:null only when NO nav config exists at all
    // (the "legacy default": create docs/nav.json). Don't gh.getFile() then -
    // it 404s and throws. Treat it as a create: empty current, null sha so the
    // apply PUT creates the file (same as create_page / a new MEMORY.md).
    if (target.file) {
      currentContent = target.file.content;
      fileSha = target.file.sha;
    } else {
      currentContent = "";
      fileSha = null;
    }
  }

  if (newContent === currentContent) {
    return {
      role: "assistant",
      content: `${proposal.summary}\n\nNothing to apply - the proposed nav matches the current ${target.path}.`,
    };
  }

  const proposalId = await savePendingProposal({
    kind: "nav",
    owner,
    repo,
    summary: proposal.summary,
    rationale: proposal.rationale,
    path: target.path,
    currentContent,
    newContent,
    fileSha,
    commitMode,
  });

  const stored = await loadPendingProposal(proposalId);
  return {
    role: "assistant",
    content: `Proposed change to ${target.path}: ${proposal.summary}`,
    attachment: { kind: "preview", data: stored as PendingProposal },
  };
}
