import type { User } from '../lib/fds'
import type { EditForm, RepoFile } from './types'

export const FDS_MCP = 'https://mcp.freedocstore.online/mcp'
export const REGISTRY_URL = 'https://freedocstore.online/registry.json'
export const CONFIG_KEY = 'fds:config:v1'
export const KBS_KEY = 'fds:kbs:v1'
export const ACTIVE_KB_KEY = 'fds:active-kb:v1'

export function nowIso() {
  return new Date().toISOString()
}

export function displayName(user: User) {
  return user.name || user.login || user.id || 'User'
}

export function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

export function proxyTarget(url: string) {
  return url.replace(/^https?:\/\//, '')
}

export function repoApiPath(repo: string) {
  return repo.split('/').map(encodeURIComponent).join('/')
}

export function upsertFile(files: RepoFile[], path: string, content: string) {
  const without = files.filter((file) => file.path !== path)
  return [...without, { path, content }]
}

export function parseJson(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('AI did not return JSON.')
    return JSON.parse(match[0])
  }
}

export function parseStoredJson<T>(value: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58)
}

export function normalizeDomain(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
}

export function isValidDomain(value: string) {
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)
}

export function setTomlScalar(content: string, key: string, value: string) {
  const lines = content.split('\n')
  const start = lines.findIndex(line => /^\s*\[project\]\s*(?:#.*)?$/.test(line))
  if (start < 0) throw new Error('Zensical configuration must include a [project] section. Ask AI to regenerate the configuration.')
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line))
  if (end < 0) end = lines.length
  const pattern = new RegExp(`^\\s*${key}\\s*=`)
  const current = lines.findIndex((line, index) => index > start && index < end && pattern.test(line))
  const replacement = `${key} = ${JSON.stringify(value)}`
  if (current >= 0) {
    if (/={1}\s*(?:"""|''')/.test(lines[current])) throw new Error(`Use a single-line ${key} in the generated Zensical configuration.`)
    lines[current] = replacement
  } else lines.splice(start + 1, 0, replacement)
  return lines.join('\n')
}

export function textToBase64(text: string) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToText(value: string) {
  const binary = atob(value.replace(/\n/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function githubEditUrl(form: EditForm) {
  const [owner, repo] = form.repo.split('/')
  const path = form.path.split('/').map(encodeURIComponent).join('/')
  return owner && repo ? `https://github.com/${owner}/${repo}/edit/${encodeURIComponent(form.branch || 'main')}/${path}` : 'https://github.com'
}

export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
