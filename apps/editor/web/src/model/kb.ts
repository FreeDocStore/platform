import { deployWorkflow } from '../../../../../templates/publishing/workflow'
export { deployWorkflow }
import { starterPublish } from './settings'
import type {
  EditForm,
  KnowledgeBaseDraft,
  PublishForm,
  PublishStep,
  RegistryKb,
  RepoFile,
  StepState,
} from './types'
import { normalizeDomain, nowIso, setTomlScalar, slugify, upsertFile } from './util'

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
  // Keep suffixed candidates within the 58-char slug limit validatePublishForm
  // enforces: trim the base so `${base}${suffix}` never exceeds it.
  const withSuffix = (suffix: string) => `${base.slice(0, 58 - suffix.length)}${suffix}`
  for (let i = 2; i < 1000; i++) {
    const candidate = withSuffix(`-${i}`)
    if (!used.has(candidate)) return candidate
  }
  return withSuffix(`-${Date.now()}`)
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
      content: `[project]\nsite_name = ${JSON.stringify(form.title)}\nsite_url = ${JSON.stringify(siteUrl)}\nrepo_url = ${JSON.stringify(`https://github.com/${form.owner}/${form.slug}`)}\ndocs_dir = "docs"\nsite_dir = "site"\n`,
    })
  }
  if (!next.some((file) => file.path === 'docs/index.md')) {
    next.push({ path: 'docs/index.md', content: `# ${form.title}\n\n${form.prompt}\n` })
  }
  return next.sort((a, b) => a.path.localeCompare(b.path))
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
