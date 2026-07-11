import { UserCircle, Wifi } from 'lucide-react'
import { type SecretStatus, type Subscription, type User } from '../lib/fds'
import {
  type KnowledgeBaseDraft,
  type PlatformConnections,
  type Settings,
  displayName,
} from '../model'
import { SettingsPanel } from './settings'

export function ProfilePage({
  settings,
  setSettings,
  secrets,
  openAiKeyInput,
  setOpenAiKeyInput,
  onSaveOpenAiKey,
  onClearOpenAiKey,
  connections,
  onCheck,
  kbs,
  user,
  signOut,
  deleteAccount,
  subscription,
  isPro,
  subLoading,
  upgrade,
  manageBilling,
  themePreference,
  setThemePreference,
  installAvailable,
  pwaReady,
  updateAvailable,
  onInstall,
  onUpdate,
}: {
  settings: Settings
  setSettings: (settings: Settings) => void
  secrets: SecretStatus
  openAiKeyInput: string
  setOpenAiKeyInput: (value: string) => void
  onSaveOpenAiKey: () => void
  onClearOpenAiKey: () => void
  connections: PlatformConnections
  onCheck: () => void
  kbs: KnowledgeBaseDraft[]
  user: User
  signOut: () => void
  deleteAccount: () => Promise<void>
  subscription: Subscription | null
  isPro: boolean
  subLoading: boolean
  upgrade: (priceId?: string) => Promise<void>
  manageBilling: () => Promise<void>
  themePreference: 'light' | 'dark' | 'system'
  setThemePreference: (preference: 'light' | 'dark' | 'system') => void
  installAvailable: boolean
  pwaReady: boolean
  updateAvailable: boolean
  onInstall: () => void
  onUpdate: () => void
}) {
  async function confirmDeleteAccount() {
    const first = window.confirm('Delete your FreeDocStore account data across platform apps? This cannot be undone.')
    if (!first) return
    const second = window.confirm('Last confirmation: permanently delete this account?')
    if (!second) return
    await deleteAccount()
  }

  return (
    <div className="profile-grid">
      <section className="panel">
        <div className="section-block fds-profile-card">
          {user.avatarUrl ? (
            <img className="profile-avatar" src={user.avatarUrl} alt="" />
          ) : (
            <div className="avatar-mark">{displayName(user).slice(0, 1).toUpperCase()}</div>
          )}
          <div>
            <h2>{displayName(user)}</h2>
            <p>FreeDocStore account</p>
            <small>Account ID: {user.id}</small>
          </div>
        </div>
        <div className="section-block">
          <div className="section-title">
            <UserCircle size={18} />
            <div>
              <h2>Account</h2>
              <p>Profile, billing, appearance, and account controls.</p>
            </div>
          </div>
          <div className="profile-action-stack">
            <div className="target-grid">
              <div>
                <span>Plan</span>
                <strong>{subLoading ? 'Checking' : isPro ? 'Pro' : 'Free'}</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{subscription?.status ?? (isPro ? 'active' : 'free')}</strong>
              </div>
            </div>
            <div className="inline-choice theme-choice" aria-label="Theme preference">
              {(['system', 'light', 'dark'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={themePreference === option ? 'choice active' : 'choice'}
                  onClick={() => setThemePreference(option)}
                >
                  {option[0].toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
            <div className="action-row">
              {isPro ? (
                <button className="secondary-action" type="button" onClick={() => manageBilling()}>
                  Manage billing
                </button>
              ) : (
                <button className="secondary-action" type="button" onClick={() => upgrade()}>
                  Upgrade
                </button>
              )}
              <button className="secondary-action" type="button" onClick={signOut}>
                Sign out
              </button>
            </div>
            <button className="secondary-action danger-action full-action" type="button" onClick={confirmDeleteAccount}>
              Delete account
            </button>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="section-block">
          <div className="section-title">
            <UserCircle size={18} />
            <div>
              <h2>FreeDocStore workspace</h2>
              <p>Knowledge-base publishing data stored for this FreeDocStore account.</p>
            </div>
          </div>
          <div className="metric-grid">
            <div><span>Drafts</span><strong>{kbs.length}</strong></div>
            <div><span>App</span><strong>FreeDocStore</strong></div>
            <div><span>Engine</span><strong>Zensical</strong></div>
          </div>
        </div>
        <PwaPanel
          installAvailable={installAvailable}
          pwaReady={pwaReady}
          updateAvailable={updateAvailable}
          onInstall={onInstall}
          onUpdate={onUpdate}
        />
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          secrets={secrets}
          openAiKeyInput={openAiKeyInput}
          setOpenAiKeyInput={setOpenAiKeyInput}
          onSaveOpenAiKey={onSaveOpenAiKey}
          onClearOpenAiKey={onClearOpenAiKey}
          connections={connections}
          onCheck={onCheck}
          manageKeys
        />
      </section>
    </div>
  )
}

export function PwaPanel({
  installAvailable,
  pwaReady,
  updateAvailable,
  onInstall,
  onUpdate,
}: {
  installAvailable: boolean
  pwaReady: boolean
  updateAvailable: boolean
  onInstall: () => void
  onUpdate: () => void
}) {
  return (
    <div className="section-block">
      <div className="section-title">
        <Wifi size={18} />
        <div>
          <h2>Web app</h2>
          <p>Installable PWA shell, offline cache, and update status.</p>
        </div>
      </div>
      <div className="target-grid">
        <div>
          <span>Offline cache</span>
          <strong>{pwaReady ? 'Ready' : 'Preparing'}</strong>
        </div>
        <div>
          <span>Updates</span>
          <strong>{updateAvailable ? 'Available' : 'Current'}</strong>
        </div>
      </div>
      <div className="action-row">
        <button className="secondary-action" type="button" onClick={onInstall} disabled={!installAvailable}>
          Install app
        </button>
        <button className="secondary-action" type="button" onClick={onUpdate} disabled={!updateAvailable}>
          Apply update
        </button>
      </div>
    </div>
  )
}
