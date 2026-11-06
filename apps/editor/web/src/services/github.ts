import { fds as app } from '../lib/fds'
import { base64ToText, githubHeaders, repoApiPath } from '../model'

export async function readGitHubFile(repo: string, path: string, branch: string) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const res = await app.proxy.fetch(`api.github.com/repos/${repoApiPath(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, {
    headers: githubHeaders(),
  })
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`)
  const json = await res.json()
  if (json.encoding !== 'base64' || typeof json.content !== 'string') throw new Error('GitHub path is not a text file.')
  return base64ToText(json.content)
}

export interface GitHubMarkdownSource { path: string; sourceText: string; sourceVersion: string }
export async function listGitHubMarkdownSources(repo: string, branch: string): Promise<GitHubMarkdownSource[]> {
  const refRes = await app.proxy.fetch(`api.github.com/repos/${repoApiPath(repo)}/git/ref/heads/${encodeURIComponent(branch)}`, { headers: githubHeaders() })
  if (!refRes.ok) throw new Error(`Could not verify the repository branch (${refRes.status}).`)
  const ref = await refRes.json() as { object?: { sha?: string } }
  if (!ref.object?.sha) throw new Error('GitHub did not return a verified branch version.')
  const treeRes = await app.proxy.fetch(`api.github.com/repos/${repoApiPath(repo)}/git/trees/${encodeURIComponent(ref.object.sha)}?recursive=1`, { headers: githubHeaders() })
  if (!treeRes.ok) throw new Error(`Could not inventory repository pages (${treeRes.status}).`)
  const tree = await treeRes.json() as { truncated?: boolean; tree?: Array<{ path: string; type: string }> }
  if (tree.truncated) throw new Error('The repository is too large to inventory safely in one request.')
  const paths = (tree.tree ?? []).filter(item => item.type === 'blob' && item.path.startsWith('docs/') && item.path.endsWith('.md')).map(item => item.path)
  const result: GitHubMarkdownSource[] = []
  for (const path of paths) {
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const response = await app.proxy.fetch(`api.github.com/repos/${repoApiPath(repo)}/contents/${encoded}?ref=${encodeURIComponent(ref.object.sha)}`, { headers: githubHeaders() })
    if (!response.ok) throw new Error(`Could not verify ${path} (${response.status}).`)
    const file = await response.json() as { encoding?: string; content?: string; sha?: string }
    if (file.encoding !== 'base64' || typeof file.content !== 'string' || !file.sha) throw new Error(`GitHub returned incomplete source metadata for ${path}.`)
    result.push({ path, sourceText: base64ToText(file.content), sourceVersion: file.sha })
  }
  return result
}

export async function readGitHubFileVersion(repo: string, path: string, branch: string): Promise<string> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const response = await app.proxy.fetch(`api.github.com/repos/${repoApiPath(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, { headers: githubHeaders() })
  if (!response.ok) throw new Error(`Could not verify ${path} (${response.status}).`)
  const value = await response.json() as { sha?: string }
  if (!value.sha) throw new Error(`GitHub did not return a source version for ${path}.`)
  return value.sha
}
