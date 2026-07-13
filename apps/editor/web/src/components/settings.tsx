import { KeyRound, ShieldCheck, UserCircle } from 'lucide-react'
import { type SecretStatus } from '../lib/fds'
import {
  AI_PROVIDERS,
  AI_PROVIDER_IDS,
  type ConnectionState,
  type PlatformConnections,
  type Settings,
} from '../model'
import { Field } from './ui'

export function SettingsPanel({
  settings,
  setSettings,
  secrets,
  connections,
  onCheck,
  onOpenProfile,
  compact = false,
}: {
  settings: Settings
  setSettings: (s: Settings) => void
  secrets: SecretStatus
  connections: PlatformConnections
  onCheck: () => void
  onOpenProfile?: () => void
  compact?: boolean
}) {
  const providerSpec = AI_PROVIDERS[settings.provider]
  const connectedCount = [connections.github, connections.ai, connections.cloudflare].filter((state) => state === 'ready').length
  const keyStatus = secrets[settings.provider]?.configured ? `${providerSpec.label} key saved` : `No ${providerSpec.label} key saved`
  return (
    <details className="section-block settings-details" open={!compact}>
      <summary>
        <span className="summary-title">
          <KeyRound size={18} />
          <span>
            <strong>Platform connections</strong>
            <small>{connectedCount}/3 ready. API keys are managed from Profile.</small>
          </span>
        </span>
      </summary>
      <div className="connection-grid">
        <ConnectionBadge label="GitHub" state={connections.github} detail="Repository create/read/write through the platform proxy" />
        <ConnectionBadge label={providerSpec.label} state={connections.ai} detail="AI generation through your saved BYOK key" />
        <ConnectionBadge label="Cloudflare" state={connections.cloudflare} detail="Deploy credentials held by platform/org secrets" />
      </div>
      <p className="connection-detail">{connections.detail}</p>
      <div className="field-grid two">
        <label className="field">
          <span>AI provider</span>
          <select
            value={settings.provider}
            onChange={(event) => {
              const provider = event.target.value as Settings['provider']
              setSettings({ ...settings, provider, model: AI_PROVIDERS[provider].defaultModel })
            }}
          >
            {AI_PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {AI_PROVIDERS[id].label}
              </option>
            ))}
          </select>
        </label>
        <Field label="Model" value={settings.model} onChange={(v) => setSettings({ ...settings, model: v })} />
      </div>
      <div className="byok-strip">
        <div>
          <span>{providerSpec.label} API key</span>
          <strong>{keyStatus}</strong>
          <p>Encrypted in your FreeDocStore account and used server-side for all KB generation and AI edits.</p>
        </div>
        {onOpenProfile && (
          <button className="secondary-action" type="button" onClick={onOpenProfile}>
            <UserCircle size={17} />
            Manage in Profile
          </button>
        )}
      </div>
      <div className="action-row compact-actions">
        <button className="secondary-action" type="button" onClick={onCheck}>
          <ShieldCheck size={17} />
          Check platform connections
        </button>
      </div>
    </details>
  )
}

export function ConnectionBadge({ label, state, detail }: { label: string; state: ConnectionState; detail: string }) {
  const text = {
    unchecked: 'Not checked',
    checking: 'Checking',
    ready: 'Ready',
    'needs-setup': 'Needs setup',
    error: 'Error',
  }[state]
  return (
    <div className={`connection-badge ${state}`}>
      <span>{label}</span>
      <strong>{text}</strong>
      <p>{detail}</p>
    </div>
  )
}
