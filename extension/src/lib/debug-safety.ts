// Guards for the local debug bridge (settings.debug).
//
// The sink is a developer-only diagnostics channel. Two hard rules keep it
// from becoming a data-exfiltration or remote-control vector:
//   1. The sink URL must be LOOPBACK only. A remote sink would stream page
//      content + full conversations off-box; we refuse to POST anywhere but
//      localhost/127.0.0.1/[::1].
//   2. Payloads are SCRUBBED of token-shaped secrets before they leave, in
//      case a user pastes a token into the chat (which would otherwise ride
//      out in a "conversation" event).

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

/**
 * True only for an http(s) URL whose host is loopback. Everything else
 * (remote host, file:, malformed) is rejected so the sink can never point
 * off the local machine.
 */
export function isLoopbackSinkUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(u.hostname);
}

// Token shapes we never want leaving the machine, even to a local sink:
// GitHub PAT/OAuth/App tokens, GitHub fine-grained PATs, Anthropic, OpenAI.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[posur]_[A-Za-z0-9]{20,}\b/g, // ghp_ gho_ ghu_ ghs_ ghr_
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // OpenAI. The char class MUST allow `-`/`_` so modern prefixed keys
  // (sk-proj-…, sk-svcacct-…, sk-admin-…) are caught - the old [A-Za-z0-9]
  // class stopped at the first dash after the prefix and left them unredacted,
  // streaming live keys to the debug sink. sk-ant- is handled above (earlier in
  // the list, so it's already redacted before this broader pattern runs).
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
];

/** Replace token-shaped substrings with a placeholder. Idempotent. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted-secret]");
  return out;
}

// Key-name based redaction (complements the shape-based scrubSecrets above):
// walk an object and replace any value under a secret-y key with "<redacted>".
// Used before pasting a settings object into a public dump.
//
// Require BOTH a secret-y key AND a value long enough to plausibly be a token,
// so short enum values ("sendKey": "enter") aren't needlessly redacted. 12
// chars catches the smallest GitHub tokens while letting short enums through.
const SECRET_KEY_RE = /(token|key|secret|password|pat)/i;
const MIN_REDACT_LEN = 12;
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactSecrets) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const looksSecret =
        SECRET_KEY_RE.test(k) && typeof v === "string" && v.length >= MIN_REDACT_LEN;
      out[k] = looksSecret ? "<redacted>" : redactSecrets(v);
    }
    return out as T;
  }
  return value;
}
