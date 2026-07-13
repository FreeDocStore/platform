import type { SecretStatus } from '../lib/fds'
import { AI_PROVIDERS } from './ai'
import type {
  AiProvider,
  ApplyMode,
  EditForm,
  PlatformConnections,
  PublishForm,
  RepoFile,
  Settings,
} from './types'
import { isValidDomain } from './util'

export const emptySettings: Settings = {
  provider: 'github',
  model: AI_PROVIDERS.github.defaultModel,
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

export function normalizeSettings(value: Partial<Settings> | null | undefined): Settings {
  const provider: AiProvider = value?.provider && value.provider in AI_PROVIDERS ? value.provider : 'github'
  const model = typeof value?.model === 'string' && value.model.trim() ? value.model : AI_PROVIDERS[provider].defaultModel
  const applyMode: ApplyMode = value?.applyMode === 'direct' ? 'direct' : 'pr'
  return { provider, model, applyMode }
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
  if (AI_PROVIDERS[provider].free) return
  if (!secrets[provider as Exclude<AiProvider, 'github'>]?.configured) {
    throw new Error(`Save your ${AI_PROVIDERS[provider].label} BYOK key in Profile > Platform connections before using AI generation.`)
  }
}

export function validatePlatformAccess(user: unknown) {
  if (!user) throw new Error('Sign in to FreeDocStore before publishing or editing.')
}
