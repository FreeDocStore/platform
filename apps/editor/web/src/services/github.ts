import { fds as app } from '../lib/fds'
import {
  type PublishForm,
  type RepoFile,
  base64ToText,
  githubHeaders,
  proxyTarget,
  repoApiPath,
  textToBase64,
} from '../model'

export async function createRepo(form: PublishForm) {
  const viewer = await githubJson('https://api.github.com/user')
  const isUser = viewer.login?.toLowerCase() === form.owner.toLowerCase()
  const url = isUser ? 'https://api.github.com/user/repos' : `https://api.github.com/orgs/${encodeURIComponent(form.owner)}/repos`
  const res = await app.proxy.fetch(proxyTarget(url), {
    method: 'POST',
    headers: githubHeaders(),
    body: JSON.stringify({
      name: form.slug,
      description: `${form.title} - FreeDocStore Zensical knowledge base`,
      private: form.visibility === 'private',
      auto_init: true,
      homepage: form.customDomain ? `https://${form.customDomain}/` : `https://${form.slug}.pages.dev/`,
    }),
  })
  if (res.status === 422) {
    return githubJson(`https://api.github.com/repos/${encodeURIComponent(form.owner)}/${encodeURIComponent(form.slug)}`)
  }
  if (!res.ok) throw new Error(`GitHub repo create failed: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function writeFiles(repo: string, files: RepoFile[]) {
  for (const file of files) {
    await writeGitHubFile(repo, file.path, file.content)
  }
}

export async function writeGitHubFile(repo: string, path: string, content: string) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const url = `https://api.github.com/repos/${repoApiPath(repo)}/contents/${encodedPath}`
  let sha: string | undefined
  const existing = await app.proxy.fetch(proxyTarget(url), { headers: githubHeaders() })
  if (existing.ok) {
    const json = await existing.json()
    sha = json.sha
  }
  const res = await app.proxy.fetch(proxyTarget(url), {
    method: 'PUT',
    headers: githubHeaders(),
    body: JSON.stringify({
      message: `${sha ? 'Update' : 'Add'} ${path}`,
      content: textToBase64(content),
      sha,
    }),
  })
  if (!res.ok) throw new Error(`GitHub write failed for ${path}: ${res.status} ${await res.text()}`)
}

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

export async function githubJson(url: string) {
  const res = await app.proxy.fetch(proxyTarget(url), { headers: githubHeaders() })
  if (!res.ok) throw new Error(`GitHub API failed: ${res.status} ${await res.text()}`)
  return res.json()
}
