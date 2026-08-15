import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  findKnowledgeBase,
  readRegistry,
  updateRepoFiles,
} from "../github.js";
import {
  type Env,
  type McpProps,
  txt,
  repoFromInput,
  requireRepoWrite,
} from "./helpers.js";
import { logMutation } from "./audit.js";

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
      })).min(1).describe("Files to create or replace"),
      delete_paths: z.array(z.string()).optional().describe("File paths to delete"),
      branch: z.string().optional().describe("Base branch, default main"),
      mode: z.enum(["pr", "direct"]).optional().describe("'pr' (default) opens a pull request; 'direct' commits to the base branch"),
      pr_title: z.string().optional().describe("Pull request title, defaults to the commit message"),
      pr_body: z.string().optional().describe("Pull request body describing the proposal"),
      dry_run: z.boolean().optional().describe("If true, return the computed change plan without writing to GitHub"),
      confirm: z.boolean().optional().describe("Required (true) for mode 'direct' to commit straight to the base branch"),
    },
    async ({ repo, message, files, delete_paths, branch, mode, pr_title, pr_body, dry_run, confirm }) => {
      const token = requireRepoWrite(agent.props);
      const effectiveMode = mode ?? "pr";
      let fullRepo = repoFromInput(agent.env, repo);
      try {
        const registry = await readRegistry(agent.env.REGISTRY_URL);
        const kb = findKnowledgeBase(registry, repo);
        if (kb) fullRepo = kb.source.repo;
      } catch {
        // registry unavailable; fall back to repo input as-is
      }
      const changed = [
        ...files.map((f) => `- ${f.path}`),
        ...(delete_paths ?? []).map((p) => `- ${p} (deleted)`),
      ].join("\n");

      if (dry_run) {
        return txt([
          `Dry run — no changes written to ${fullRepo}.`,
          "",
          `Mode: ${effectiveMode}`,
          `Base branch: ${branch ?? "main"}`,
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

      if (effectiveMode === "direct" && !confirm) {
        return txt(`Direct commit to ${fullRepo} requires confirm: true. Re-run with confirm: true to commit straight to ${branch ?? "main"}, or use mode "pr" to open a reviewable proposal.`);
      }

      const result = await updateRepoFiles({
        token,
        repoFullName: fullRepo,
        message,
        files,
        deletePaths: delete_paths,
        baseBranch: branch,
        mode: effectiveMode,
        prTitle: pr_title,
        prBody: pr_body,
      });
      if (!result.ok) return txt(`Update failed for ${fullRepo}: ${result.error}`);
      await logMutation(agent.env, agent.props, {
        tool: "update_files",
        action: effectiveMode === "direct" ? "commit" : "open_pr",
        target: fullRepo,
        detail: {
          mode: effectiveMode,
          branch: result.branch,
          commitSha: result.commitSha,
          prNumber: result.prNumber,
          paths: [...files.map((f) => f.path), ...(delete_paths ?? [])],
        },
      });
      if (result.prUrl) {
        return txt([
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
        `Committed directly to ${result.branch} on ${fullRepo}.`,
        "",
        `Commit: ${result.commitUrl ?? result.commitSha}`,
        "",
        "Files:",
        changed,
        "",
        "GitHub Actions will build and deploy this change.",
      ].join("\n"));
    },
  );
}
