import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveTarget } from './target.js';
import { type Env, type McpProps, txt, toolError } from './helpers.js';
import { formatGitHubError, githubJson, requireRepoRead } from './github-api.js';

interface Agent { server: McpServer; env: Env; props: McpProps }
interface PullRequest { number: number; title: string; state: string; body?: string | null; html_url?: string; draft?: boolean; merged?: boolean; user?: { login?: string } }
interface PullFile { filename: string; status: string; additions: number; deletions: number; changes: number }

async function registeredRepo(agent: Agent, input: string, token?: string): Promise<string> {
  const target = await resolveTarget(agent.env, input, undefined, token);
  if (!target.kbId) throw new Error('Proposal inspection is available only for a registered public knowledge base.');
  return target.repo;
}

export function registerProposalTools(agent: Agent) {
  agent.server.tool(
    'list_proposals',
    'List review proposals (pull requests) for a registered public FreeDocStore knowledge base.',
    {
      repo: z.string().describe('Registered knowledge-base id or its registered owner/name'),
      state: z.enum(['open', 'closed', 'all']).default('open').describe('Proposal state to list (default open)'),
    },
    async ({ repo, state }) => {
      try {
        const token = requireRepoRead(agent.props);
        const fullRepo = await registeredRepo(agent, repo, token);
        const response = await githubJson<PullRequest[]>(`https://api.github.com/repos/${fullRepo}/pulls?state=${state}&per_page=50`, token);
        if (!Array.isArray(response)) return toolError('GitHub returned an invalid proposal list. Retry the request.');
        if (response.length === 0) return txt(`No ${state === 'all' ? '' : `${state} `}proposals found for ${fullRepo}.`);
        const lines = response.map(pr => `- #${pr.number} ${pr.title} (${pr.state}${pr.draft ? ', draft' : ''}${pr.merged ? ', merged' : ''})${pr.html_url ? `\n  ${pr.html_url}` : ''}`);
        if (response.length === 50) lines.push('Results are limited to 50 proposals; use a narrower state filter to inspect more.');
        return txt(`${response.length} ${state === 'all' ? '' : `${state} `}proposal(s) for ${fullRepo}:\n${lines.join('\n')}`);
      } catch (error) { return toolError(formatGitHubError(error, `listing proposals for ${repo}`)); }
    },
  );

  agent.server.tool(
    'inspect_pr',
    'Inspect a proposal pull request and its changed files in a registered public knowledge base.',
    {
      repo: z.string().describe('Registered knowledge-base id or its registered owner/name'),
      pr_number: z.number().int().min(1).describe('Positive pull request number'),
    },
    async ({ repo, pr_number }) => {
      if (!Number.isInteger(pr_number) || pr_number < 1) return toolError('Pull request number must be a positive integer.');
      try {
        const token = requireRepoRead(agent.props);
        const fullRepo = await registeredRepo(agent, repo, token);
        const base = `https://api.github.com/repos/${fullRepo}/pulls/${pr_number}`;
        const pr = await githubJson<PullRequest>(base, token);
        if (!pr || pr.number !== pr_number || typeof pr.title !== 'string') return toolError(`GitHub returned invalid details for proposal #${pr_number}.`);
        const files: PullFile[] = [];
        let truncated = false;
        for (let page = 1; page <= 3; page += 1) {
          const chunk = await githubJson<PullFile[]>(`${base}/files?per_page=100&page=${page}`, token);
          if (!Array.isArray(chunk)) return toolError(`GitHub returned an invalid changed-file list for proposal #${pr_number}.`);
          files.push(...chunk);
          if (chunk.length < 100) break;
          if (page === 3) truncated = true;
        }
        const body = (pr.body ?? '').replace(/\s+/g, ' ').trim();
        const summary = body.length > 500 ? `${body.slice(0, 497)}…` : body || '(no description)';
        const listing = files.length ? files.map(file => `- ${file.filename} (${file.status}; +${file.additions}/-${file.deletions})`).join('\n') : '(no changed files returned)';
        return txt([
          `Proposal #${pr.number}: ${pr.title}`,
          `Repository: ${fullRepo}`,
          `State: ${pr.merged ? 'merged' : pr.state}${pr.draft ? ' (draft)' : ''}`,
          `Author: ${pr.user?.login ?? '(unknown)'}`,
          ...(pr.html_url ? [`URL: ${pr.html_url}`] : []),
          `Description: ${summary}`,
          `Changed files (${files.length}${truncated ? ', first 300 shown; list truncated' : ''}):`,
          listing,
        ].join('\n'));
      } catch (error) { return toolError(formatGitHubError(error, `inspecting proposal #${pr_number} for ${repo}`)); }
    },
  );
}
