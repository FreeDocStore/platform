import { apiJson, type EditResult } from '../lib/fds'

export interface OrganizationInstallation { id: number; account: { login: string; type: string }; permissions: Record<string, string>; repositorySelection: string; configureUrl: string }
export interface SetupRepository { id: number; fullName: string; name: string; branch: string; canConfigure: boolean }
export interface HostingProject { name: string; production_branch: string; domains: string[]; configured?: boolean }
export interface HostingConnection { repo: string; accountId: string; accountName: string; status: 'connecting' | 'ready' | 'failed' | 'removed'; version?: string; updatedAt: string; projects: HostingProject[] }
export interface LifecycleHistory { event: string; actor: string; at: string; details: Record<string, string | number | boolean | null> }
export interface PublishingRecord { repoId?: number; repoFullName?: string; status?: 'active' | 'unpublished' | 'disconnected'; history?: LifecycleHistory[] }
export interface SetupPlan {
  planId: string; credentialVersion: string; repo: string; branch: string; project: string; domain: string; url: string; accountName: string;
  files: Array<{ path: string; content: string; before: string; expectedSha: string | null }>;
  replacesWorkflow: boolean; warning: string | null; hasDraftChanges: boolean; draftTitle: string; draftSlug: string;
}
export interface DeploymentStatus { state: 'awaiting-review' | 'setup-closed' | 'waiting' | 'building' | 'failed' | 'verifying' | 'live'; message: string; prUrl?: string; runUrl?: string; url?: string; pagesUrl?: string; pagesReady?: boolean; domainReady?: boolean; failedSteps?: string[]; registryKbId?: string; registrationWarning?: string }
const post = <T>(path: string, body: unknown, signal?: AbortSignal) => apiJson<T>(`/api/provisioning/${path}`, { method: 'POST', body: JSON.stringify(body), signal })
export const provisioning = {
  installations: () => apiJson<{ installations: OrganizationInstallation[]; installUrl: string | null; installationWarning: string | null }>('/api/provisioning/installations'),
  repositories: (id: number) => apiJson<{ repositories: SetupRepository[] }>(`/api/provisioning/repositories?installation=${id}`),
  connection: (repo: string) => apiJson<{ connection: HostingConnection | null; setup: ({ project: string; domain: string; branch: string; accountId: string; credentialVersion?: string } & PublishingRecord) | null }>(`/api/provisioning/connection?repo=${encodeURIComponent(repo)}`),
  accounts: (token: string, accountId = '') => post<{ accounts: Array<{ id: string; name: string }>; projects?: HostingProject[] }>('accounts', { token, accountId }),
  connect: (repo: string, token: string, accountId: string) => post<{ connection: HostingConnection }>('connect', { repo, token, accountId }),
  staging: (repo: string, cursor = '') => apiJson<{ versions: HostingConnection[]; cursor: string | null }>(`/api/provisioning/staging?repo=${encodeURIComponent(repo)}&cursor=${encodeURIComponent(cursor)}`),
  cleanup: (repo: string, version: string) => post<{ removed: boolean }>('cleanup', { repo, version, confirm: true }),
  plan: (repo: string, project: string, domain: string, confirmCreateProject: boolean, confirmUseProject: boolean, confirmRepoint: boolean, draftFiles: Array<{path:string;content:string}> = [], title = '', draftSlug = '') => post<SetupPlan>('plan', { repo, project, domain, title, draftSlug, confirmCreateProject, confirmUseProject, confirmRepoint, draftFiles }),
  apply: (planId: string, mode: 'pr' | 'direct', confirmReplaceWorkflow: boolean, confirmDraftContent: boolean) => post<EditResult>('apply', { planId, mode, confirmReplaceWorkflow, confirmDraftContent }),
  deploy: (repo: string) => post<{ ok: boolean }>('deploy', { repo }),
  register: (repo: string, signal?: AbortSignal) => post<DeploymentStatus>('register', { repo }, signal),
  status: (repo: string, signal?: AbortSignal) => apiJson<DeploymentStatus>(`/api/provisioning/status?repo=${encodeURIComponent(repo)}`, { signal }),
  reconcile: (repoId: number, repo: string) => post<{ status: string; record: { message: string }; setup: PublishingRecord }>(`${repoId}/reconcile`, { repo }),
  unpublish: (repoId: number, repo: string, confirm: boolean) => post<{ effects: string[]; requiresConfirmation?: boolean; status?: string; registryWarning?: string }>(`${repoId}/unpublish`, { repo, confirm }),
  disconnect: (repoId: number, repo: string, confirm: boolean, removeSecrets = false) => post<{ effects: string[]; requiresConfirmation?: boolean; status?: string; removedSecrets?: Array<{name:string;removed:boolean}> }>(`${repoId}/disconnect`, { repo, confirm, removeSecrets }),
  history: (repoId: number, repo: string) => apiJson<{ history: LifecycleHistory[] }>(`/api/provisioning/${repoId}/history?repo=${encodeURIComponent(repo)}`),
}
