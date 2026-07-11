import { type ReactNode } from 'react'
import {
  Home,
  LayoutDashboard,
  LibraryBig,
  PenLine,
  RefreshCw,
  ShieldCheck,
  UserCircle,
  Wifi,
} from 'lucide-react'
import { type User } from '../lib/fds'
import { type AppRoute, FDS_MCP, displayName } from '../model'

export function StoreHeader({
  route,
  navigate,
  user,
  signOut,
  pwaReady,
  updateAvailable,
  onUpdate,
}: {
  route: AppRoute
  navigate: (route: AppRoute) => void
  user: User
  signOut: () => void
  pwaReady: boolean
  updateAvailable: boolean
  onUpdate: () => void
}) {
  return (
    <header className="store-topbar">
      <div className="store-topbar-inner">
        <button className="brand-lockup" type="button" onClick={() => navigate('dashboard')} aria-label="FreeDocStore dashboard">
          <span className="brand-mark">F</span>
          <span>
            <strong>FreeDocStore</strong>
            <small>Console</small>
          </span>
        </button>
        <AppNav route={route} navigate={navigate} />
        <div className="account-strip">
          <span className={pwaReady ? 'pwa-chip ready' : 'pwa-chip'}>
            <Wifi size={14} />
            <span>{pwaReady ? 'Offline ready' : 'Web app'}</span>
          </span>
          {updateAvailable && (
            <button className="pwa-chip update" type="button" onClick={onUpdate}>
              <RefreshCw size={14} />
              <span>Update</span>
            </button>
          )}
          <button className="account-pill" type="button" onClick={() => navigate('profile')} aria-label="Open profile">
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span>{displayName(user).slice(0, 1).toUpperCase()}</span>}
            <strong>{displayName(user)}</strong>
          </button>
          <button className="text-action signout-action" type="button" onClick={signOut}>Sign out</button>
        </div>
      </div>
    </header>
  )
}

export function AppNav({ route, navigate }: { route: AppRoute; navigate: (route: AppRoute) => void }) {
  return (
    <nav className="app-nav" aria-label="Console pages">
      <button className={route === 'dashboard' ? 'mode active' : 'mode'} onClick={() => navigate('dashboard')} type="button">
        <Home size={17} />
        Console
      </button>
      <button className={route === 'publish' ? 'mode active' : 'mode'} onClick={() => navigate('publish')} type="button">
        <LibraryBig size={17} />
        Publish
      </button>
      <button className={route === 'edit' ? 'mode active' : 'mode'} onClick={() => navigate('edit')} type="button">
        <PenLine size={17} />
        Edit
      </button>
      <button className={route === 'profile' ? 'mode active' : 'mode'} onClick={() => navigate('profile')} type="button">
        <UserCircle size={17} />
        Profile
      </button>
      <a className="mode link-mode" href={FDS_MCP} target="_blank" rel="noreferrer">
        <ShieldCheck size={17} />
        MCP
      </a>
    </nav>
  )
}

export function MobileTabBar({ route, navigate }: { route: AppRoute; navigate: (route: AppRoute) => void }) {
  const items: { route: AppRoute; label: string; icon: ReactNode }[] = [
    { route: 'dashboard', label: 'Console', icon: <LayoutDashboard size={18} /> },
    { route: 'publish', label: 'Publish', icon: <LibraryBig size={18} /> },
    { route: 'edit', label: 'Edit', icon: <PenLine size={18} /> },
    { route: 'profile', label: 'Profile', icon: <UserCircle size={18} /> },
  ]
  return (
    <nav className="mobile-tabbar" aria-label="Primary">
      {items.map((item) => (
        <button key={item.route} className={route === item.route ? 'mobile-tab active' : 'mobile-tab'} type="button" onClick={() => navigate(item.route)}>
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  )
}
