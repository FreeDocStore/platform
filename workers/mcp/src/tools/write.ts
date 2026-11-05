import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  updateRepoFiles,
  validateChanges,
} from "../github.js";
import {
  type Env,
  type McpProps,
  txt,
  toolError,
  requireRepoWrite,
} from "./helpers.js";
import { logMutation } from "./audit.js";

import { resolveTarget, renderTarget } from "./target.js";

interface Agent {
  server: McpServer;
  env: Env;
  props: McpProps;
}

export function registerWriteTools(agent: Agent) {
  agent.server.tool(
    "update_files",
    "Update Markdown/source files in a KB repo as the signed-in GitHub user. Default mode 'pr' opens a reviewable pull request (the FreeDocStore proposal flow); mode 'direct' commits straight to the base branch. Merged/pushed changes deploy automatically via GitHub Actions.",
    {
      repo: z.string().describe("Repo as owner/name, registered KB id, or repo name under the FreeDocStore org"),
      message: z.string().describe("Commit message describing the change"),
      files: z.array(z.object({
        path: z.string().describe("File path, e.g. docs/index.md"),
        content: z.string().describe("Full new file content"),
      })).max(50).describe("Files to create or replace; may be empty for a deletion-only proposal"),
      delete_paths: z.array(z.string()).optional().describe("File paths to delete"),
      expected_files: z.record(z.string(), z.string().regex(/^[a-f0-9]{40}$/).nullable()).optional().describe("Required for every changed/deleted path: reviewed blob SHA from read_file/list_files, or null for a confirmed missing file to create"),
      branch: z.string().optional().describe("Override the registered source branch or actual repository default"),
      mode: z.enum(["pr", "direct"]).optional().describe("'pr' (default) opens a pull request; 'direct' commits to the base branch"),
      pr_title: z.string().optional().describe("Pull request title, defaults to the commit message"),
      pr_body: z.string().optional().describe("Pull request body describing the proposal"),
      dry_run: z.boolean().optional().describe("If true, return the computed change plan without writing to GitHub"),
      confirm: z.boolean().optional().describe("Required (true) for mode 'direct' to commit straight to the base branch"),
    },
    async ({ repo, message, files, delete_paths, branch, mode, pr_title, pr_body, dry_run, confirm, expected_files }) => {
      const token = requireRepoWrite(agent.props);
      const effectiveMode = mode ?? "pr";
      if (effectiveMode === 'direct' && !confirm && !dry_run) return toolError('Direct mode requires confirm: true. Review the source and proposal before committing.');
      try {
        validateChanges(files, delete_paths ?? [], expected_files!);
        const target = await resolveTarget(agent.env, repo, branch, token);
        const fullRepo = target.repo;
        const changed = [
          ...files.map((f) => `- ${f.path}`),
          ...(delete_paths ?? []).map((p) => `- ${p} (deleted)`),
        ].join("\n");

        const result = await updateRepoFiles({
          token,
          repoFullName: fullRepo,
          message,
          files,
          deletePaths: delete_paths,
          baseBranch: target.branch,
          expectedFiles: expected_files!,
          dryRun: dry_run,
          mode: effectiveMode,
          prTitle: pr_title,
          prBody: pr_body,
        });
        if (!result.ok) return toolError(`Update failed for ${fullRepo}: ${result.error}${result.branch ? ` Proposal branch ${result.branch} exists without a confirmed PR; inspect it on GitHub before retrying.` : ""}`);
        const reviewedTarget = { ...target, commitSha: result.baseCommitSha ?? target.commitSha };
        if (dry_run) {
          return txt([
            `Dry run — no changes written to ${fullRepo}.`,
            "",
            `Mode: ${effectiveMode}`,
            renderTarget(reviewedTarget),
            `Expected files: ${JSON.stringify(expected_files)}`,
            `Commit message: ${message}`,
            "",
            "Files:",
            changed,
            "",
            effectiveMode === "direct"
              ? "Re-run with dry_run: false and confirm: true to commit directly."
              : "Re-run with dry_run: false to open the proposal PR.",
          ].join("\n"));
        }

        if (result.unchanged) return txt(`${renderTarget(reviewedTarget)}\n\nNo changes: the reviewed files already match this source. No commit or PR was created.`);
        let auditWarning = '';
        try { await logMutation(agent.env, agent.props, {
          tool: "update_files",
          action: effectiveMode === "direct" ? "commit" : "open_pr",
          target: fullRepo,
          detail: {
            mode: effectiveMode,
            baseBranch: target.branch,
            expectedFiles: expected_files,
            branch: result.branch,
            commitSha: result.commitSha,
            prNumber: result.prNumber,
            paths: [...files.map((f) => f.path), ...(delete_paths ?? [])],
          },
        }); } catch { auditWarning = 'The change succeeded, but audit history could not be saved.'; }
        if (result.prUrl) {
          return txt([
            renderTarget(reviewedTarget),
            auditWarning,
            `Opened proposal PR #${result.prNumber} on ${fullRepo}.`,
            "",
            `PR: ${result.prUrl}`,
            `Branch: ${result.branch}`,
            `Commit: ${result.commitSha}`,
            "",
            "Files:",
            changed,
            "",
            "Review the diff and merge the PR to publish. GitHub Actions deploys on merge.",
          ].join("\n"));
        }
        return txt([
          renderTarget(reviewedTarget),
          auditWarning,
          `Committed directly to ${result.branch} on ${fullRepo}.`,
          "",
          `Commit: ${result.commitUrl ?? result.commitSha}`,
          "",
          "Files:",
          changed,
          "",
          "GitHub Actions will build and deploy this change.",
        ].join("\n"));
      } catch (error) { return toolError(`Update failed: ${error instanceof Error ? error.message : 'Could not verify source. Retry.'}`); }
    },
  );
}
