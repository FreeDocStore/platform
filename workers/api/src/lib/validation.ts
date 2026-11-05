export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

export function stringField(body: Record<string, unknown>, key: string, fallback = ''): string {
  const value = body[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value.trim();
}

export const validOwner = (owner: string) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner);
export function validRepo(repo: string): boolean {
  const parts = repo.split('/');
  return parts.length === 2 && validOwner(parts[0]) && /^[\w.-]{1,100}$/.test(parts[1]) && !['.', '..'].includes(parts[1]);
}
export function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !/[\\\x00-\x1f\x7f]/.test(path) && !path.startsWith('/') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}
export function validBranch(branch: string): boolean {
  return branch.length > 0 && branch.length <= 200 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) && !branch.includes('..') && !branch.includes('@{') && !branch.includes('//') && !/^[\/-]|[\/.]$/.test(branch) && !branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'));
}
export const validDomain = (domain: string) => /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
