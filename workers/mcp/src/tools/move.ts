import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listRepoFiles, readRepoFile, updateRepoFiles, validateChanges } from '../github.js';
import { validPath } from '../validation.js';
import { type Env, type McpProps, txt, toolError, requireRepoWrite } from './helpers.js';
import { logMutation } from './audit.js';
import { formatGitHubError, requireRepoRead } from './github-api.js';
import { resolveTarget, renderTarget } from './target.js';

interface Agent { server: McpServer; env: Env; props: McpProps }
interface LinkReference { file: string; target: string }

function validDocumentPath(path: string, docsDir: string): boolean {
  return validPath(path) && path.startsWith(`${docsDir}/`) && path.toLowerCase().endsWith('.md');
}

function resolvedLinkPath(from: string, rawTarget: string): string | null {
  let target = rawTarget.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
  if (!target || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return null;
  try { target = decodeURIComponent(target); } catch { return null; }
  const rootRelative = target.startsWith('/');
  if (rootRelative) target = target.slice(1);
  const stack = rootRelative ? [] : from.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (stack.length) stack.pop(); else return null; }
    else stack.push(part);
  }
  return stack.join('/');
}

function findReferences(markdown: string, from: string, sourcePath: string): LinkReference[] {
  const refs: LinkReference[] = [];
  const linkPattern = /!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g;
  const definitionPattern = /^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm;
  for (const pattern of [linkPattern, definitionPattern]) {
    for (const match of markdown.matchAll(pattern)) {
      const target = match[1];
      if (resolvedLinkPath(from, target) === sourcePath) refs.push({ file: from, target });
    }
  }
  return refs;
}

export function registerMoveTools(agent: Agent) {
  agent.server.tool(
    'move_document',
    'Propose moving a Markdown document within a registered public FreeDocStore knowledge base.',
    {
      repo: z.string().describe('Registered knowledge-base id or its registered owner/name'),
      source_path: z.string().describe('Existing Markdown document path inside the registered docs directory'),
      destination_path: z.string().describe('New Markdown document path inside the registered docs directory'),
      dry_run: z.boolean().default(false).describe('Return the reviewed move plan without creating a proposal'),
      confirm: z.boolean().default(false).describe('Must be true to create the reviewable move proposal'),
    },
    async ({ repo, source_path, destination_path, dry_run, confirm }) => {
      if (!validPath(source_path) || !validPath(destination_path)) return toolError('Invalid document path. Paths cannot be absolute, contain traversal, empty segments, control characters, or .git.');
      try {
        const writeToken = !dry_run && confirm ? requireRepoWrite(agent.props) : undefined;
        const readToken = requireRepoRead(agent.props);
        const target = await resolveTarget(agent.env, repo, undefined, readToken);
        if (!target.kbId) return toolError('Document moves are available only for a registered public knowledge base.');
        if (!validDocumentPath(source_path, target.source.docs_dir) || !validDocumentPath(destination_path, target.source.docs_dir)) {
          return toolError(`Source and destination must be Markdown files under ${target.source.docs_dir}/.`);
        }
        if (source_path === destination_path) return toolError('Source and destination paths are identical.');
        const files = await listRepoFiles(target.repo, target.branch, target.commitSha, readToken);
        const source = await readRepoFile(target.repo, source_path, target.commitSha, readToken);
        if (!source) return toolError(`Source document ${source_path} was not found at the reviewed source commit.`);
        const destination = await readRepoFile(target.repo, destination_path, target.commitSha, readToken);
        if (destination) return toolError(`Move conflict: destination ${destination_path} already exists.`);
        const docsMarkdown = files.filter(file => file.type === 'blob' && file.path.startsWith(`${target.source.docs_dir}/`) && file.path.endsWith('.md') && file.path !== source_path);
        if (docsMarkdown.length > 200) return toolError(`Cannot validate navigation references safely: ${docsMarkdown.length} Markdown files exceed the 200-file scan limit.`);
        const affected: LinkReference[] = [];
        for (const file of docsMarkdown) {
          const content = await readRepoFile(target.repo, file.path, target.commitSha, readToken);
          if (content) affected.push(...findReferences(content.content, file.path, source_path));
        }
        const expectedFiles = { [source_path]: source.sha, [destination_path]: null };
        validateChanges([{ path: destination_path, content: source.content }], [source_path], expectedFiles);
        if (!dry_run && confirm) {
          const result = await updateRepoFiles({
            token: writeToken!,
            repoFullName: target.repo,
            message: `Move ${source_path} to ${destination_path}`,
            files: [{ path: destination_path, content: source.content }],
            deletePaths: [source_path],
            baseBranch: target.branch,
            expectedFiles,
            mode: 'pr',
          });
          if (!result.ok) return toolError(`Move proposal failed: ${result.error ?? 'GitHub did not accept the proposal.'}`);
          if (result.unchanged) return txt(`${renderTarget(target)}\n\nNo move was created; the source is unchanged.`);
          let auditMessage = `Audit: move_document proposed ${source_path} → ${destination_path} by ${agent.props?.login ?? agent.props?.userId ?? 'connected user'}.`;
          if (agent.env.FDS_API_KV && agent.props?.userId) {
            try {
              await logMutation(agent.env, agent.props, {
                tool: 'move_document', action: 'open_pr', target: target.repo,
                detail: { sourcePath: source_path, destinationPath: destination_path, branch: target.branch, expectedFiles, prNumber: result.prNumber, commitSha: result.commitSha, affectedLinks: affected },
              });
            } catch { auditMessage += ' Audit persistence failed.'; }
          } else auditMessage += ' Audit persistence is unavailable because FDS_API_KV is not bound.';
          return txt([
            renderTarget({ ...target, commitSha: result.baseCommitSha ?? target.commitSha }),
            `Opened move proposal PR #${result.prNumber}: ${result.prUrl ?? '(URL unavailable)'}`,
            auditMessage,
            affected.length ? `Navigation links referencing the old path (${affected.length}):\n${affected.map(ref => `- ${ref.file}: ${ref.target}`).join('\n')}` : 'No Markdown navigation links to the source path were found.',
            'The source Markdown content was copied to the destination unchanged; review the proposal before merging.',
          ].join('\n\n'));
        }
        const preview = dry_run ? 'Dry run — no proposal was created.' : 'Confirmation required — no proposal was created. Re-run with confirm: true to open a reviewable PR.';
        return txt([
          preview,
          renderTarget(target),
          `Move: ${source_path} → ${destination_path}`,
          `Source blob: ${source.sha}`,
          'Source bytes: preserved as the destination file content.',
          `Navigation links referencing the old path (${affected.length}):`,
          affected.length ? affected.map(ref => `- ${ref.file}: ${ref.target}`).join('\n') : '- None found.',
          `Expected source baseline: ${JSON.stringify(expectedFiles)}`,
        ].join('\n'));
      } catch (error) { return toolError(formatGitHubError(error, `preparing move in ${repo}`)); }
    },
  );
}
