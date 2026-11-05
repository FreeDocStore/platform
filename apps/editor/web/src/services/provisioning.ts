import { apiJson, type EditResult } from '../lib/fds'

export interface OrganizationInstallation { id: number; account: { login: string; type: string }; permissions: Record<string, string>; repositorySelection: string; configureUrl: string }
export interface SetupRepository { fullName: string; name: string; branch: string; canConfigure: boolean }
export interface HostingProject { name: string; production_branch: string; domains: string[]; configured?: boolean }
export interface HostingConnection { repo: string; accountId: string; accountName: string; status: 'connecting' | 'ready' | 'failed'; updatedAt: string; projects: HostingProject[] }
export interface SetupPlan {
  planId: string; repo: string; branch: string; project: string; domain: string; url: string; accountName: string;
  files: Array<{ path: string; content: string; before: string; expectedSha: string | null }>;
  replacesWorkflow: boolean; warning: string | null;
}
export interface DeploymentStatus { state: 'awaiting-review' | 'setup-closed' | 'waiting' | 'building' | 'failed' | 'verifying' | 'live'; message: string; prUrl?: string; runUrl?: string; url?: string; pagesUrl?: string; pagesReady?: boolean; domainReady?: boolean; failedSteps?: string[]; registryKbId?: string; registrationWarning?: string }
const post = <T>(path: string, body: unknown, signal?: AbortSignal) => apiJson<T>(`/api/provisioning/${path}`, { method: 'POST', body: JSON.stringify(body), signal })
export const provisioning = {
  installations: () => apiJson<{ installations: OrganizationInstallation[]; installUrl: string | null; installationWarning: string | null }>('/api/provisioning/installations'),
  repositories: (id: number) => apiJson<{ repositories: SetupRepository[] }>(`/api/provisioning/repositories?installation=${id}`),
  connection: (repo: string) => apiJson<{ connection: HostingConnection | null; setup: { project: string; domain: string; branch: string; accountId: string } | null }>(`/api/provisioning/connection?repo=${encodeURIComponent(repo)}`),
  accounts: (token: string, accountId = '') => post<{ accounts: Array<{ id: string; name: string }>; projects?: HostingProject[] }>('accounts', { token, accountId }),
  connect: (repo: string, token: string, accountId: string, confirmOverwrite: boolean) => post<{ connection: HostingConnection }>('connect', { repo, token, accountId, confirmOverwrite }),
  plan: (repo: string, project: string, domain: string, confirmCreateProject: boolean, confirmUseProject: boolean, confirmRepoint: boolean) => post<SetupPlan>('plan', { repo, project, domain, confirmCreateProject, confirmUseProject, confirmRepoint }),
  apply: (planId: string, mode: 'pr' | 'direct', confirmReplaceWorkflow: boolean) => post<EditResult>('apply', { planId, mode, confirmReplaceWorkflow }),
  deploy: (repo: string) => post<{ ok: boolean }>('deploy', { repo }),
  register: (repo: string, signal?: AbortSignal) => post<DeploymentStatus>('register', { repo }, signal),
  status: (repo: string, signal?: AbortSignal) => apiJson<DeploymentStatus>(`/api/provisioning/status?repo=${encodeURIComponent(repo)}`, { signal }),
}
