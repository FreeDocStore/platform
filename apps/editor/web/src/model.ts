import type { SecretStatus, User } from './lib/fds'

export type AiProvider = 'openai' | 'anthropic'

export interface AiProviderSpec {
  label: string
  endpoint: string
  defaultModel: string
  keyPrefix: string
  keysUrl: string
}

export const AI_PROVIDERS: Record<AiProvider, AiProviderSpec> = {
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4.1-mini',
    keyPrefix: 'sk-',
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-6',
    keyPrefix: 'sk-ant-',
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
}

export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS) as AiProvider[]

export const FDS_MCP = 'https://mcp.freedocstore.online/mcp'
export const REGISTRY_URL = 'https://freedocstore.online/registry.json'
export const CONFIG_KEY = 'fds:config:v1'
export const KBS_KEY = 'fds:kbs:v1'
export const ACTIVE_KB_KEY = 'fds:active-kb:v1'

export type AppRoute = 'dashboard' | 'publish' | 'edit' | 'profile'
export type AuthProvider = 'github' | 'google'
export type StepState = 'idle' | 'busy' | 'ok' | 'error'
export type ConnectionState = 'unchecked' | 'checking' | 'ready' | 'needs-setup' | 'error'
export type PwaInstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export type ApplyMode = 'pr' | 'direct'

export interface Settings {
  provider: AiProvider
  model: string
  /** How edits are applied: 'pr' opens a reviewable pull request (approval), 'direct' commits to the branch. */
  applyMode: ApplyMode
}

export interface PlatformConnections {
  github: ConnectionState
  ai: ConnectionState
  cloudflare: ConnectionState
  detail: string
}

export interface PublishForm {
  title: string
  slug: string
  owner: string
  customDomain: string
  visibility: 'public' | 'private'
  prompt: string
}

export interface EditForm {
  repo: string
  branch: string
  path: string
  instruction: string
}

export interface RegistryKb {
  id: string
  title: string
  source: { repo: string; branch?: string }
  cloudflare?: { production_url?: string }
}

export interface RepoFile {
  path: string
  content: string
}

export interface Proposal {
  summary: string
  rationale: string
  content: string
}

export interface PublishStep {
  id: string
  label: string
  detail: string
  state: StepState
}

export interface KnowledgeBaseDraft extends PublishForm {
  id: string
  files: RepoFile[]
  liveUrl: string
  repoUrl: string
  lastStatus: string
  createdAt: string
  updatedAt: string
  steps: PublishStep[]
}

export const emptySettings: Settings = {
  provider: 'openai',
  model: AI_PROVIDERS.openai.defaultModel,
  applyMode: 'pr',
}

export const emptySecrets: SecretStatus = {
  openai: { configured: false, label: '' },
  anthropic: { configured: false, label: '' },
}

export const initialConnections: PlatformConnections = {
  github: 'unchecked',
  ai: 'needs-setup',
  cloudflare: 'ready',
  detail: 'Save your OpenAI or Anthropic BYOK key once in your FreeDocStore account. Cloudflare deploy credentials live in platform/org secrets.',
}

export const starterPublish: PublishForm = {
  title: 'True Non-Profit',
  slug: 'true-non-profit',
  owner: 'FreeDocStore',
  customDomain: '',
  visibility: 'public',
  prompt:
    'A first-principles knowledge base about non-profits, what they should be, how to assess trueness, and how to maintain a public evidence register.',
}

export const starterEdit: EditForm = {
  repo: 'FreeDocStore/true-non-profit',
  branch: 'main',
  path: 'docs/index.md',
  instruction: 'Make this page clearer for a new reader while preserving the same factual claims.',
}

export const initialSteps: PublishStep[] = [
  { id: 'plan', label: 'Plan', detail: 'Create Zensical structure', state: 'idle' },
  { id: 'ai', label: 'Draft', detail: 'Generate Markdown files', state: 'idle' },
  { id: 'repo', label: 'Repo', detail: 'Create GitHub repository', state: 'idle' },
  { id: 'files', label: 'Files', detail: 'Commit Zensical source', state: 'idle' },
  { id: 'registry', label: 'Registry', detail: 'Register in the public library', state: 'idle' },
  { id: 'deploy', label: 'Deploy', detail: 'GitHub Actions publishes to Cloudflare', state: 'idle' },
]

export function cloneSteps() {
  return initialSteps.map((step) => ({ ...step }))
}

export function nowIso() {
  return new Date().toISOString()
}

export function createKnowledgeBase(form: PublishForm): KnowledgeBaseDraft {
  const timestamp = nowIso()
  return {
    ...form,
    customDomain: normalizeDomain(form.customDomain),
    id: crypto.randomUUID(),
    files: [],
    liveUrl: '',
    repoUrl: '',
    lastStatus: 'Draft',
    createdAt: timestamp,
    updatedAt: timestamp,
    steps: cloneSteps(),
  }
}

export function normalizeSettings(value: Partial<Settings> | null | undefined): Settings {
  const provider: AiProvider = value?.provider && value.provider in AI_PROVIDERS ? value.provider : 'openai'
  const model = typeof value?.model === 'string' && value.model.trim() ? value.model : AI_PROVIDERS[provider].defaultModel
  const applyMode: ApplyMode = value?.applyMode === 'direct' ? 'direct' : 'pr'
  return { provider, model, applyMode }
}

export function normalizeKnowledgeBase(value: Partial<KnowledgeBaseDraft> & PublishForm): KnowledgeBaseDraft {
  const base = createKnowledgeBase({ ...starterPublish, ...value })
  return {
    ...base,
    id: value.id || base.id,
    files: Array.isArray(value.files) ? value.files : [],
    liveUrl: value.liveUrl || '',
    repoUrl: value.repoUrl || '',
    lastStatus: value.lastStatus || 'Draft',
    createdAt: value.createdAt || base.createdAt,
    updatedAt: value.updatedAt || base.updatedAt,
    steps: Array.isArray(value.steps) && value.steps.length ? value.steps : cloneSteps(),
  }
}

export function toPublishForm(kb: KnowledgeBaseDraft): PublishForm {
  return {
    title: kb.title,
    slug: kb.slug,
    owner: kb.owner,
    customDomain: kb.customDomain,
    visibility: kb.visibility,
    prompt: kb.prompt,
  }
}

export function livePageUrl(library: RegistryKb[], form: Pick<EditForm, 'repo' | 'path'>): string | null {
  const kb = library.find((entry) => entry.source.repo.toLowerCase() === form.repo.trim().toLowerCase())
  const base = kb?.cloudflare?.production_url
  if (!base) return null
  let rel = form.path.trim().replace(/^docs\//, '')
  if (rel === 'index.md' || rel === '') rel = ''
  else if (rel.endsWith('/index.md')) rel = rel.slice(0, -'index.md'.length)
  else rel = rel.replace(/\.md$/, '/')
  try {
    return new URL(rel, base).toString()
  } catch {
    return null
  }
}

export const KB_DOMAIN_SUFFIX = 'freedocstore.online'

export function liveTargetFor(form: Pick<PublishForm, 'slug' | 'customDomain'>) {
  return form.customDomain ? `https://${form.customDomain}/` : `https://${form.slug}.${KB_DOMAIN_SUFFIX}/`
}

export function nextAvailableSlug(kbs: KnowledgeBaseDraft[], desired: string) {
  const base = slugify(desired) || 'knowledge-base'
  const used = new Set(kbs.map((kb) => kb.slug))
  if (!used.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

export function displayName(user: User) {
  return user.name || user.login || user.id || 'User'
}

export interface AppLocation {
  route: AppRoute
  /** KB id being edited (edit route only). */
  kbId: string
  /** File path within the KB being edited (edit route only). */
  file: string
}

export function locationFromUrl(): AppLocation {
  const segments = window.location.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const first = segments[0] || 'dashboard'
  if (first === 'edit') {
    const kbId = segments[1] ? decodeURIComponent(segments[1]) : ''
    const file = segments.slice(2).map(decodeURIComponent).join('/')
    return { route: 'edit', kbId, file }
  }
  if (first === 'publish' || first === 'profile') return { route: first, kbId: '', file: '' }
  return { route: 'dashboard', kbId: '', file: '' }
}

export function urlForLocation(loc: Partial<AppLocation> & { route: AppRoute }): string {
  if (loc.route === 'edit') {
    if (!loc.kbId) return '/edit'
    const base = `/edit/${encodeURIComponent(loc.kbId)}`
    return loc.file ? `${base}/${loc.file.split('/').map(encodeURIComponent).join('/')}` : base
  }
  return loc.route === 'dashboard' ? '/' : `/${loc.route}`
}

export function pushLocation(loc: Partial<AppLocation> & { route: AppRoute }) {
  const next = urlForLocation(loc)
  if (window.location.pathname !== next) window.history.pushState(null, '', next)
}

export function replaceLocation(loc: Partial<AppLocation> & { route: AppRoute }) {
  const next = urlForLocation(loc)
  if (window.location.pathname !== next) window.history.replaceState(null, '', next)
}

export function deployWorkflow(project: string, customDomain: string) {
  const domains = [`${project}.${KB_DOMAIN_SUFFIX}`, ...(customDomain ? [customDomain] : [])].join(' ')
  return `name: Deploy Zensical KB

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  deployments: write

concurrency:
  group: deploy-zensical
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - run: python -m pip install zensical
      - run: python -m zensical build --strict
      - name: Inject FreeDocStore source metadata
        run: |
          node <<'NODE'
          const fs = require('node:fs');
          const path = require('node:path');

          const repo = process.env.GITHUB_REPOSITORY;
          if (!repo) throw new Error('GITHUB_REPOSITORY is not set');

          const siteDir = 'site';
          const docsDir = 'docs';
          const sourceExts = ['.md', '.mdx', '.markdown', '.html', '.htm'];

          function walk(dir) {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
              const full = path.join(dir, entry.name);
              return entry.isDirectory() ? walk(full) : [full];
            });
          }

          function escapeAttr(value) {
            return String(value)
              .replace(/&/g, '&amp;')
              .replace(/"/g, '&quot;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
          }

          function sourceForHtml(file) {
            let rel = path.relative(siteDir, file).split(path.sep).join('/');
            if (rel === 'index.html') rel = 'index';
            else if (rel.endsWith('/index.html')) rel = rel.slice(0, -'/index.html'.length);
            else rel = rel.replace(/\.html?$/i, '');
            const candidates = sourceExts.map((ext) => path.posix.join(docsDir, rel + ext));
            return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
          }

          for (const file of walk(siteDir).filter((candidate) => /\.html?$/i.test(candidate))) {
            let html = fs.readFileSync(file, 'utf8');
            html = html.replace(/<meta\s+[^>]*name=["']source-repo["'][^>]*>\s*/gi, '');
            html = html.replace(/<meta\s+[^>]*name=["']source-path["'][^>]*>\s*/gi, '');
            const sourcePath = sourceForHtml(file);
            const meta = [
              '<meta name="source-repo" content="' + escapeAttr(repo) + '">',
              '<meta name="source-path" content="' + escapeAttr(sourcePath) + '">',
            ].join('\\n      ');
            if (/<head[^>]*>/i.test(html)) {
              html = html.replace(/<head([^>]*)>/i, '<head$1>\\n      ' + meta);
            } else {
              html = meta + '\\n' + html;
            }
            fs.writeFileSync(file, html);
          }
          NODE
      - name: Ensure Cloudflare Pages project
        run: npx wrangler pages project create "${project}" --production-branch=main || true
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: Deploy to Cloudflare Pages
        run: npx wrangler pages deploy site --project-name="${project}" --branch=main
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: Attach domains
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PROJECT: ${project}
          DOMAINS: ${domains}
        run: |
          set -e
          api() { curl -sS -H "Authorization: Bearer \$CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "\$@"; }
          for DOMAIN in \$DOMAINS; do
            api -X POST "https://api.cloudflare.com/client/v4/accounts/\$CLOUDFLARE_ACCOUNT_ID/pages/projects/\$PROJECT/domains" \\
              --data "{\\"name\\":\\"\$DOMAIN\\"}" > /dev/null || true
            ZONE="\${DOMAIN#*.}"
            ZONE_ID=\$(api "https://api.cloudflare.com/client/v4/zones?name=\$ZONE" | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print(r[0]["id"] if r else "")')
            [ -z "\$ZONE_ID" ] && { echo "No zone for \$DOMAIN, skipping"; continue; }
            EXISTS=\$(api "https://api.cloudflare.com/client/v4/zones/\$ZONE_ID/dns_records?type=CNAME&name=\$DOMAIN" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["result"]))')
            if [ "\$EXISTS" = "0" ]; then
              api -X POST "https://api.cloudflare.com/client/v4/zones/\$ZONE_ID/dns_records" \\
                --data "{\\"type\\":\\"CNAME\\",\\"name\\":\\"\$DOMAIN\\",\\"content\\":\\"\$PROJECT.pages.dev\\",\\"proxied\\":true}" > /dev/null
            fi
            echo "Ensured \$DOMAIN"
          done
`
}

export function ensureFallbackFiles(files: RepoFile[], form: PublishForm, workflow: string): RepoFile[] {
  let next = [...files]
  const siteUrl = liveTargetFor(form)
  next = upsertFile(next, '.github/workflows/deploy.yml', workflow)
  next = upsertFile(next, '.gitignore', 'site/\n.cache/\n.DS_Store\n')
  if (!next.some((file) => file.path === 'README.md')) {
    next.push({ path: 'README.md', content: `# ${form.title}\n\nFreeDocStore Zensical knowledge base.\n\nSource lives in \`docs/\` and builds with \`python -m zensical build --strict\`.\n` })
  }
  const zensicalIndex = next.findIndex((file) => file.path === 'zensical.toml')
  if (zensicalIndex >= 0) {
    next[zensicalIndex] = {
      ...next[zensicalIndex],
      content: setTomlScalar(setTomlScalar(next[zensicalIndex].content, 'site_url', siteUrl), 'repo_url', `https://github.com/${form.owner}/${form.slug}`),
    }
  } else {
    next.push({
      path: 'zensical.toml',
      content: `site_name = "${form.title.replace(/"/g, '\\"')}"\nsite_url = "${siteUrl}"\nrepo_url = "https://github.com/${form.owner}/${form.slug}"\ndocs_dir = "docs"\nsite_dir = "site"\n\n[nav]\nitems = [\n  { title = "Overview", path = "index.md" },\n  { title = "First Principles", path = "first-principles.md" },\n  { title = "Assessment Method", path = "assessment-method.md" },\n  { title = "Register", path = "register.md" },\n]\n`,
    })
  }
  if (!next.some((file) => file.path === 'docs/index.md')) {
    next.push({ path: 'docs/index.md', content: `# ${form.title}\n\n${form.prompt}\n` })
  }
  return next.sort((a, b) => a.path.localeCompare(b.path))
}

export function validateKbFiles(files: RepoFile[]) {
  const paths = new Set(files.map((file) => file.path))
  const failures = [
    ['zensical.toml', !paths.has('zensical.toml')],
    ['docs/index.md', !paths.has('docs/index.md')],
    ['Markdown under docs/', !files.some((file) => file.path.startsWith('docs/') && file.path.endsWith('.md'))],
    ['no generated site output', files.some((file) => file.path.startsWith('site/') || file.path.endsWith('.html'))],
  ].filter(([, failed]) => failed)
  if (failures.length) throw new Error(`Generated files failed Zensical validation: ${failures.map(([name]) => name).join(', ')}`)
}

export function validatePublishForm(form: PublishForm) {
  if (!form.title.trim()) throw new Error('Title is required.')
  if (!/^[a-z][a-z0-9-]{1,57}$/.test(form.slug)) throw new Error('Slug must be lowercase letters, numbers, and hyphens.')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(form.owner.trim())) throw new Error('GitHub owner must be a valid user or organization name.')
  if (form.customDomain && !isValidDomain(form.customDomain)) throw new Error('Custom domain must be a valid hostname.')
  if (!form.prompt.trim()) throw new Error('Prompt is required.')
}

export function validateAi(settings: Settings) {
  if (!(settings.provider in AI_PROVIDERS)) throw new Error('Choose an AI provider.')
  if (!settings.model.trim()) throw new Error('Model is required.')
}

export function validateByok(secrets: SecretStatus, provider: AiProvider) {
  if (!secrets[provider]?.configured) {
    throw new Error(`Save your ${AI_PROVIDERS[provider].label} BYOK key in Profile > Platform connections before using AI generation.`)
  }
}

export function validatePlatformAccess(user: unknown) {
  if (!user) throw new Error('Sign in to FreeDocStore before publishing or editing.')
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
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const line = `${key} = "${escaped}"`
  const pattern = new RegExp(`^${key}\\s*=\\s*(['"]).*\\1$`, 'm')
  return pattern.test(content) ? content.replace(pattern, line) : `${line}\n${content}`
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

export function buildLineDiff(before: string, after: string) {
  if (before === after) return 'No content changes proposed.'
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i++]}`)
      j++
    } else if (rows[i + 1][j] >= rows[i][j + 1]) out.push(`- ${a[i++]}`)
    else out.push(`+ ${b[j++]}`)
  }
  while (i < a.length) out.push(`- ${a[i++]}`)
  while (j < b.length) out.push(`+ ${b[j++]}`)
  return out.join('\n')
}

export function resetSteps(active: string, state: StepState) {
  return initialSteps.map((step) => ({ ...step, state: step.id === active ? state : 'idle' as StepState }))
}

export function updateStep(id: string, state: StepState, detail: string) {
  return (prev: PublishStep[]) => prev.map((step) => (step.id === id ? { ...step, state, detail } : step))
}

export function markCurrentError(current: PublishStep[]) {
  const busy = current.find((step) => step.state === 'busy')
  if (!busy) return current
  return current.map((step) => (step.id === busy.id ? { ...step, state: 'error' as StepState } : step))
}

export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
