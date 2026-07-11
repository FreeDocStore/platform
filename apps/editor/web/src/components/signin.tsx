import { ExternalLink, Github, Loader2 } from 'lucide-react'
import type { AuthProvider } from '../model'

export function LoadingScreen() {
  return (
    <div className="auth-screen">
      <Loader2 className="spin" size={22} />
      <p>Checking session...</p>
    </div>
  )
}

export function SignedOutLanding({ signIn }: { signIn: (provider?: AuthProvider) => void }) {
  return (
    <main className="auth-screen auth-landing">
      <div className="auth-card">
        <span className="brand-mark large">F</span>
        <p className="eyebrow">FreeDocStore Console</p>
        <h1>Prompt and publish knowledge bases.</h1>
        <p className="lede">Sign in to see your KBs, prompt new Zensical Markdown books, publish them on Cloudflare Pages, and manage custom domains.</p>
        <div className="auth-actions">
          <button className="primary-action" type="button" onClick={() => signIn('google')}>
            <span className="provider-mark" aria-hidden="true">G</span>
            Continue with Google
          </button>
          <button className="secondary-action" type="button" onClick={() => signIn('github')}>
            <Github size={17} />
            Continue with GitHub
          </button>
          <a className="secondary-action as-link" href="https://freedocstore.online/" target="_blank" rel="noreferrer">
            <ExternalLink size={17} />
            Open FreeDocStore
          </a>
        </div>
      </div>
    </main>
  )
}
