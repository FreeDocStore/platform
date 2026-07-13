export interface Env {
  FDS_API_KV: KVNamespace;
  EDITOR_BASE_URL: string;
  PUBLIC_BASE_URL: string;
  COOKIE_DOMAIN?: string;
  GITHUB_ORG: string;
  GH_APP_CLIENT_ID?: string;
  GH_APP_CLIENT_SECRET?: string;
  GITHUB_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  FDS_KEY_ENCRYPTION_KEY?: string;
}

export type AuthProvider = "github" | "google";

export interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  html_url?: string | null;
}

export interface GoogleUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  profile?: string;
}

export interface Session {
  id: string;
  user: {
    id: string;
    provider: AuthProvider;
    login: string;
    name: string;
    avatarUrl: string;
    githubUrl: string;
    email?: string;
  };
  githubAccessToken?: string;
  createdAt: string;
  updatedAt: string;
}

export type Variables = {
  session: Session | null;
};

export const SESSION_COOKIE = "fds_session";
export const STATE_PREFIX = "oauth_state:";
export const SESSION_PREFIX = "session:";
export const USER_SESSION_PREFIX = "user_session:";
export const USER_KV_PREFIX = "user_kv:";
export const USER_SECRET_PREFIX = "user_secret:";
export const SESSION_TTL = 60 * 60 * 24 * 30;
export const STATE_TTL = 60 * 10;

interface ByokProvider {
  /** Third-party API host the proxy injects this key for. */
  host: string;
  /** Accepted key format. */
  prefix: RegExp;
}

export const BYOK_PROVIDERS: Record<string, ByokProvider> = {
  openai: { host: "api.openai.com", prefix: /^sk-[A-Za-z0-9_-]{12,}$/ },
  anthropic: { host: "api.anthropic.com", prefix: /^sk-ant-[A-Za-z0-9_-]{12,}$/ },
};

export const PROXY_HOST_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.entries(BYOK_PROVIDERS).map(([id, p]) => [p.host, id]),
);
