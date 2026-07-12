import { useEffect, useState } from 'react'

export interface User {
  id: string
  provider: 'github' | 'google'
  login: string
  name: string
  avatarUrl: string
  githubUrl: string
  email?: string
}

export interface Subscription {
  status: string
}

export type ThemePreference = 'light' | 'dark' | 'system'

export type ByokProvider = 'openai' | 'anthropic'

export interface ProviderKeyStatus {
  configured: boolean
  label: string
}

export type SecretStatus = Record<ByokProvider, ProviderKeyStatus>

export interface PublishKbResult {
  ok: boolean
  repo: string
  repoUrl: string
  liveUrl: string
  steps: Array<{ id: 'repo' | 'files' | 'registry'; ok: boolean; detail: string }>
}

const API_BASE = (import.meta.env.VITE_FDS_API_BASE as string | undefined) || 'https://api.freedocstore.online'
const THEME_KEY = 'fds:theme:v1'

async function apiFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  })
  return res
}

async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

function applyTheme(preference: ThemePreference) {
  const dark = preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
}

export const fds = {
  apiBase: API_BASE,
  kv: {
    async get<T>(key: string): Promise<T | null> {
      const data = await apiJson<{ value: T | null }>(`/api/kv/${encodeURIComponent(key)}`)
      return data.value ?? null
    },
    async set<T>(key: string, value: T): Promise<void> {
      await apiJson(`/api/kv/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
    },
  },
  proxy: {
    fetch(target: string, init: RequestInit = {}) {
      return apiFetch(`/api/proxy?target=${encodeURIComponent(target)}`, init)
    },
  },
  async publishKb(input: {
    title: string
    slug: string
    owner: string
    customDomain?: string
    description?: string
    files: Array<{ path: string; content: string }>
  }): Promise<PublishKbResult> {
    const res = await apiFetch('/api/publish', { method: 'POST', body: JSON.stringify(input) })
    const data = (await res.json().catch(() => null)) as PublishKbResult | { error?: string } | null
    if (!data) throw new Error(`Publish failed: ${res.status}`)
    if ('error' in data && data.error) throw new Error(data.error)
    return data as PublishKbResult
  },
  secrets: {
    get(): Promise<SecretStatus> {
      return apiJson<SecretStatus>('/api/secrets')
    },
    async setKey(provider: ByokProvider, value: string): Promise<SecretStatus> {
      return apiJson<SecretStatus>(`/api/secrets/${provider}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
    },
    async clearKey(provider: ByokProvider): Promise<SecretStatus> {
      return apiJson<SecretStatus>(`/api/secrets/${provider}`, {
        method: 'DELETE',
      })
    },
  },
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    setLoading(true)
    try {
      const data = await apiJson<{ authenticated: boolean; user: User | null }>('/api/me')
      setUser(data.authenticated ? data.user : null)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  function signIn(provider: 'github' | 'google' = 'github') {
    window.location.href = `${API_BASE}/auth/${provider}/start?next=${encodeURIComponent(window.location.href)}`
  }

  async function signOut() {
    await apiFetch('/api/logout', { method: 'POST' }).catch(() => {})
    setUser(null)
  }

  async function deleteAccount() {
    await apiFetch('/api/account', { method: 'DELETE' })
    setUser(null)
  }

  return { user, loading, signIn, signOut, deleteAccount, refresh }
}

export function useSubscription() {
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiJson<{ status: string }>('/api/billing')
      .then((data) => setSubscription({ status: data.status }))
      .catch(() => setSubscription({ status: 'free' }))
      .finally(() => setLoading(false))
  }, [])

  return {
    subscription,
    isPro: false,
    loading,
    upgrade: async () => {
      window.alert('Paid FreeDocStore plans are not enabled yet.')
    },
    manageBilling: async () => {
      window.alert('Billing management is not enabled yet.')
    },
  }
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
  })

  useEffect(() => {
    applyTheme(preference)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(preference)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [preference])

  function setPreference(next: ThemePreference) {
    localStorage.setItem(THEME_KEY, next)
    setPreferenceState(next)
  }

  return { preference, setPreference }
}
