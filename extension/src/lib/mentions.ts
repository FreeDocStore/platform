// @mention parsing for chat prompts. A teammate is tagged by writing
// "@their-github-login" in an edit request; the parsed set is stored on the
// task so the board can surface "you're mentioned" to that person.
//
// Matches GitHub's username rules: alphanumeric plus single hyphens, 1-39
// chars, no leading/trailing hyphen. The leading boundary rejects mid-word @
// (e.g. an email local@host) so only real mentions are captured. Pure and
// import-safe (unit-tested).

const MENTION_RE = /(?:^|[^A-Za-z0-9_@/])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/g;

/**
 * Extract the distinct GitHub logins mentioned in a chat prompt, lowercased
 * and de-duplicated, preserving first-seen order. Returns [] when there are
 * none. Login comparison elsewhere should also lowercase, since GitHub logins
 * are case-insensitive.
 */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const login = m[1].toLowerCase();
    if (!seen.has(login)) {
      seen.add(login);
      out.push(login);
    }
  }
  return out;
}

/**
 * Merge freshly-parsed mentions into an existing list (union, first-seen
 * order preserved). Used to accumulate mentions across a thread's turns so a
 * teammate tagged on turn 1 stays flagged even if a later turn doesn't repeat
 * the mention.
 */
export function mergeMentions(prior: string[] | undefined, next: string[]): string[] {
  const out = [...(prior ?? [])];
  const seen = new Set(out);
  for (const m of next) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}
