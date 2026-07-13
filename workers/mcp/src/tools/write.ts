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
    },
    async ({ repo, message, files, delete_paths, branch, mode, pr_title, pr_body }) => {
      const token = requireRepoWrite(agent.props);
      let fullRepo = repoFromInput(agent.env, repo);
      try {
        const registry = await readRegistry(agent.env.REGISTRY_URL);
        const kb = findKnowledgeBase(registry, repo);
        if (kb) fullRepo = kb.source.repo;
      } catch {
        // registry unavailable; fall back to repo input as-is
      }
      const result = await updateRepoFiles({
        token,
        repoFullName: fullRepo,
        message,
        files,
        deletePaths: delete_paths,
        baseBranch: branch,
        mode: mode ?? "pr",
        prTitle: pr_title,
        prBody: pr_body,
      });
      if (!result.ok) return txt(`Update failed for ${fullRepo}: ${result.error}`);
      const changed = [
        ...files.map((f) => `- ${f.path}`),
        ...(delete_paths ?? []).map((p) => `- ${p} (deleted)`),
      ].join("\n");
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
