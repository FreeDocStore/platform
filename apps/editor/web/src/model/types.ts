export type AiProvider = 'github' | 'openai' | 'anthropic'

export interface AiProviderSpec {
  label: string
  endpoint: string
  defaultModel: string
  /** Free tier that needs no BYOK key (uses the user's GitHub sign-in). */
  free?: boolean
  keyPrefix?: string
  keysUrl?: string
}

export type AppRoute = 'dashboard' | 'publish' | 'edit' | 'profile'
export type AuthProvider = 'github' | 'google'
export type StepState = 'idle' | 'busy' | 'ok' | 'error'
export type ConnectionState = 'unchecked' | 'checking' | 'ready' | 'needs-setup' | 'error'
export type PwaInstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export interface AiUsage {
  prompt: number
  completion: number
  total: number
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

export interface AppLocation {
  route: AppRoute
  /** KB id being edited (edit route only). */
  kbId: string
  /** File path within the KB being edited (edit route only). */
  file: string
}
