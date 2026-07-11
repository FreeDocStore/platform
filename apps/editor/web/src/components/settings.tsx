import { KeyRound, ShieldCheck, UserCircle } from 'lucide-react'
import { type SecretStatus } from '../lib/fds'
import {
  type ConnectionState,
  type PlatformConnections,
  type Settings,
} from '../model'
import { Field } from './ui'

export function SettingsPanel({
  settings,
  setSettings,
  secrets,
  openAiKeyInput = '',
  setOpenAiKeyInput,
  onSaveOpenAiKey,
  onClearOpenAiKey,
  connections,
  onCheck,
  onOpenProfile,
  compact = false,
  manageKeys = false,
}: {
  settings: Settings
  setSettings: (s: Settings) => void
  secrets: SecretStatus
  openAiKeyInput?: string
  setOpenAiKeyInput?: (value: string) => void
  onSaveOpenAiKey?: () => void
  onClearOpenAiKey?: () => void
  connections: PlatformConnections
  onCheck: () => void
  onOpenProfile?: () => void
  compact?: boolean
  manageKeys?: boolean
}) {
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings({ ...settings, [key]: value })
  const connectedCount = [connections.github, connections.openai, connections.cloudflare].filter((state) => state === 'ready').length
  const openAiKeyStatus = secrets.openai.configured ? `Saved as ${secrets.openai.label}` : 'No OpenAI key saved'
  return (
    <details className="section-block settings-details" open={!compact || connectedCount < 3}>
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
        <ConnectionBadge label="OpenAI" state={connections.openai} detail="AI generation through your saved BYOK key" />
        <ConnectionBadge label="Cloudflare" state={connections.cloudflare} detail="Deploy credentials held by platform/org secrets" />
      </div>
      <p className="connection-detail">{connections.detail}</p>
      <div className="byok-strip">
        <div>
          <span>OpenAI API key</span>
          <strong>{openAiKeyStatus}</strong>
          <p>Encrypted in your FreeDocStore account and used server-side for all KB generation and AI edits.</p>
        </div>
        {manageKeys && secrets.openai.configured && onClearOpenAiKey ? (
          <button className="secondary-action danger-action" type="button" onClick={onClearOpenAiKey}>
            Remove key
          </button>
        ) : !manageKeys && onOpenProfile ? (
          <button className="secondary-action" type="button" onClick={onOpenProfile}>
            <UserCircle size={17} />
            Manage in Profile
          </button>
        ) : null}
      </div>
      {manageKeys && (
        <div className="field-grid two">
          <Field label="OpenAI API key" value={openAiKeyInput} onChange={setOpenAiKeyInput ?? (() => {})} placeholder="sk-..." secret />
          <Field label="OpenAI endpoint" value={settings.openaiEndpoint} onChange={(v) => update('openaiEndpoint', v)} />
          <Field label="Model" value={settings.model} onChange={(v) => update('model', v)} />
        </div>
      )}
      {!manageKeys && (
        <div className="field-grid two">
          <Field label="OpenAI endpoint" value={settings.openaiEndpoint} onChange={(v) => update('openaiEndpoint', v)} />
          <Field label="Model" value={settings.model} onChange={(v) => update('model', v)} />
        </div>
      )}
      <div className="action-row compact-actions">
        {manageKeys && onSaveOpenAiKey && (
          <button className="primary-action" type="button" onClick={onSaveOpenAiKey} disabled={!openAiKeyInput.trim()}>
            <KeyRound size={17} />
            Save API key
          </button>
        )}
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
