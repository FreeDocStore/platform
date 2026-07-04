// The shared chat() orchestration for the direct adapters (Claude + OpenAI).
//
// Both adapters ran an identical turn: build a GitHub client, ground the edit on
// the current file (or an unapplied draft), assemble the system-prompt prefix
// (memory + add-ons + activity), call the model's multi-turn loop, then turn the
// result into a reply or a proposal preview. The ONLY genuine difference is the
// wire call (callClaudeMultiTurn vs callOpenAIMultiTurn), so that is injected as
// `runModel` and everything else lives here once. This is what the "keep this
// flow in sync with the other adapter" comments used to guard by hand.

import type { ChatMessage, CommitMode, PageContext, Settings } from "../types";
import type { CallOpenAIArgs, MultiTurnResult } from "../lib/openai";
import { makeDispatch, sourceFormatOf } from "./openai-tools";
import { fetchSourceFile, loadTaskDraft, tryBuildGitHubClient } from "./source-fetch";
import { formatAddonsBlock } from "../lib/addons";
import {
  getRecentActivity,
  getRepoMemory,
  formatActivityBlock,
  formatMemoryBlock,
  buildEditProposalPreview,
  buildCreatePageProposalPreview,
  buildNavProposalPreview,
  buildMemoryProposalPreview,
  toHistory,
} from "./proposal-engine";

// Everything callClaude/callOpenAIMultiTurn need EXCEPT the adapter-specific
// apiKey + model (the runModel closure supplies those). The two arg types are
// structurally identical, so one is enough to describe the shared shape.
export type ModelTurnInput = Omit<CallOpenAIArgs, "apiKey" | "model">;

/** The adapter's own model call, with apiKey/model already bound. */
export type ModelRunner = (input: ModelTurnInput) => Promise<MultiTurnResult>;

/**
 * Run one edit/ask turn end-to-end. `runModel` is the only adapter-specific
 * piece; the caller has already validated its own settings block exist.
 */
export async function runEditTurn(
  prompt: string,
  context: PageContext,
  history: ChatMessage[],
  settings: Settings,
  opts: { taskId?: string } | undefined,
  runModel: ModelRunner,
): Promise<ChatMessage> {
  const mode = settings.mode ?? "edit";
  const isEdit = mode === "edit";

  if (isEdit && !context.repo) {
    return {
      role: "assistant",
      content: "Couldn't resolve a GitHub repo from the current page URL. Open a *.pages.dev docs site first.",
    };
  }

  try {
    // Read mode only needs a GH client when the model actually calls a read
    // tool. Build one up front when credentials exist; otherwise the dispatcher
    // returns a structured error to the model.
    const gh = await tryBuildGitHubClient(settings);

    // Edit mode requires a repo + current file for grounding. fetchSourceFile
    // tolerates a guessed extension (docs/foo.html -> docs/foo.md) and returns
    // the real path; pin it onto context so the diff/commit and the editing
    // prompt all use the resolved source.
    let file: { content: string; sha: string | null } | null = null;
    let currentPageMissing = false;
    if (isEdit && context.repo) {
      if (!gh) {
        return {
          role: "assistant",
          content: "GitHub not connected - sign in with GitHub or paste a PAT under the Claude section.",
        };
      }
      const { owner: repoOwner, name: repoName } = context.repo;
      // Follow-up on an unapplied draft: revise the DRAFT rather than the
      // committed file. The draft holds the not-yet-pushed content, and for a
      // brand-new page there is no committed file (the 404 that used to answer
      // "doesn't exist yet, nothing to edit"). fileSha rides along so a create
      // stays a create on the next Apply.
      const draft = await loadTaskDraft(opts?.taskId);
      if (draft && draft.path === context.sourcePath) {
        file = { content: draft.editedContent, sha: draft.fileSha };
      } else {
        try {
          const fetched = await fetchSourceFile(gh, repoOwner, repoName, context.sourcePath);
          file = { content: fetched.content, sha: fetched.sha };
          if (fetched.path !== context.sourcePath) {
            context = { ...context, sourcePath: fetched.path };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // The current page has no source in the repo yet (a not-yet-created
          // page, or a URL that 404s). DON'T bail - the user may want to CREATE
          // it, and create_page needs no existing file. Run the model with no
          // grounding file and a note (below) so it uses create_page instead of
          // trying to edit a file that isn't there. Non-404s are real failures.
          if (/404|not found/i.test(msg)) {
            currentPageMissing = true;
            file = null;
          } else {
            throw err;
          }
        }
      }
    }

    // Build the system-prompt prefix in priority order, most-stable first:
    // shared MEMORY.md (durable team facts), then the add-ons catalog (so the
    // agent knows what users can ask to toggle), then live git activity. The
    // add-ons block is the only one that doesn't need GH auth - it's a static
    // catalog bundled with the extension, and the current features.json comes
    // from PageContext (already fetched by the content script).
    const addonsBlock = formatAddonsBlock(
      context.features as Record<string, boolean | undefined> | null,
    );
    let systemContext = addonsBlock;
    if (gh && context.repo) {
      const [memory, commits] = await Promise.all([
        getRepoMemory(gh, context.repo.owner, context.repo.name),
        getRecentActivity(gh, context.repo.owner, context.repo.name),
      ]);
      const blocks = [
        formatMemoryBlock(memory),
        addonsBlock,
        formatActivityBlock(commits),
      ].filter((b) => b.length > 0);
      systemContext = blocks.join("\n");
    }
    if (currentPageMissing) {
      systemContext = [
        systemContext,
        `IMPORTANT: The current page's source \`${context.sourcePath}\` does NOT exist in the repo yet. If the user wants this page, call create_page with the full file content (path \`${context.sourcePath}\`). Do NOT call edit_file against it - there is nothing to edit.`,
      ].filter((b) => b && b.length > 0).join("\n\n");
    }

    const dispatch = makeDispatch(gh, context);
    const result = await runModel({
      mode,
      sourcePath: context.sourcePath,
      sourceFormat: sourceFormatOf(context.sourcePath),
      fileContent: isEdit ? (file?.content ?? "") : context.text,
      pageTitle: context.title,
      pageUrl: context.url,
      userPrompt: prompt,
      selection: context.selection ?? null,
      navConfig: context.navConfig,
      history: toHistory(history),
      systemContext,
      dispatch,
    });

    if (result.kind === "clarification") {
      const { question, why } = result.clarification;
      const suffix = why ? `\n\n_(${why})_` : "";
      return { role: "assistant", content: `${question}${suffix}` };
    }

    if (result.kind === "plain") {
      return { role: "assistant", content: result.content };
    }

    if (!isEdit) {
      // Read mode should never surface a write proposal. If the model tries
      // one, explain how to switch modes instead of committing.
      return {
        role: "assistant",
        content: "Start an edit from the ✎ thread selector at the top of the side panel to make that change (Ask is read-only).",
      };
    }

    // `file` may be null when the current page has no source yet - that MUST
    // still allow create_page / nav / memory (none need the current file), and
    // edit_file re-fetches its own target. So only require repo+gh here.
    if (!context.repo || !gh) {
      return { role: "assistant", content: "GitHub context missing - cannot commit." };
    }

    const commitMode: CommitMode = settings.commitMode ?? "pr";
    const { owner, name: repo } = context.repo;

    if (result.kind === "nav") {
      return await buildNavProposalPreview(gh, owner, repo, result.proposal, commitMode);
    }
    if (result.kind === "memory") {
      return await buildMemoryProposalPreview(gh, owner, repo, result.proposal, commitMode);
    }
    if (result.kind === "create") {
      return await buildCreatePageProposalPreview(owner, repo, context, result.proposal, commitMode, prompt, opts?.taskId, gh.login ?? undefined);
    }
    return await buildEditProposalPreview(gh, owner, repo, context, file, result, commitMode, prompt, opts?.taskId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { role: "assistant", content: `Error: ${msg}` };
  }
}
