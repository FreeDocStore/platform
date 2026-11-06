import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveTarget } from './target.js';
import { type Env, type McpProps, txt, toolError } from './helpers.js';
import { formatGitHubError, githubJson, requireRepoRead } from './github-api.js';

interface Agent { server: McpServer; env: Env; props: McpProps }
interface CodeSearch { total_count?: number; incomplete_results?: boolean; items?: Array<{ path?: string; html_url?: string; text_matches?: Array<{ fragment?: string }> }> }

export function registerSearchTools(agent: Agent) {
  agent.server.tool(
    'search_documents',
    'Search Markdown content in a registered public FreeDocStore knowledge base.',
    {
      repo: z.string().describe('Registered knowledge-base id or its registered owner/name'),
      query: z.string().max(200).describe('Words or phrase to find in the knowledge base'),
      max_results: z.number().int().min(1).max(50).default(10).describe('Maximum results to return (1–50, default 10)'),
    },
    async ({ repo, query, max_results }) => {
      if (!query.trim()) return toolError('Search query cannot be empty.');
      try {
        const token = requireRepoRead(agent.props);
        const target = await resolveTarget(agent.env, repo, undefined, token);
        if (!target.kbId) return toolError('Search is available only for a registered public knowledge base.');
        const searchQuery = `${query.trim()} repo:${target.repo}`;
        const url = `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}&per_page=${max_results}`;
        const data = await githubJson<CodeSearch>(url, token, 'application/vnd.github.text-match+json');
        if (!Array.isArray(data.items)) return toolError('GitHub returned an invalid search result. Retry the search.');
        const matches = data.items.slice(0, max_results);
        if (!matches.length) return txt(`No matches for “${query.trim()}” in ${target.repo}.`);
        const results = matches.map((item, index) => {
          const raw = item.text_matches?.find(match => typeof match.fragment === 'string')?.fragment?.replace(/\s+/g, ' ').trim() ?? 'Excerpt unavailable in GitHub search response.';
          const excerpt = raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
          return `${index + 1}. ${item.path ?? '(path unavailable)'}${item.html_url ? `\n   ${item.html_url}` : ''}\n   ${excerpt}`;
        });
        const truncated = data.incomplete_results === true || (typeof data.total_count === 'number' && data.total_count > matches.length) || data.items.length > max_results;
        return txt([
          `Search results for “${query.trim()}” in ${target.repo}: ${matches.length}${typeof data.total_count === 'number' ? ` of ${data.total_count}` : ''}.`,
          ...results,
          ...(truncated ? ['Results were truncated to the requested maximum; narrow the query or increase max_results.'] : []),
        ].join('\n\n'));
      } catch (error) { return toolError(formatGitHubError(error, `searching ${repo}`)); }
    },
  );
}
