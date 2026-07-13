import type { AppLocation, AppRoute } from './types'

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
