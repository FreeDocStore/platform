import { parseDocument } from 'yaml';
import type { NavItem } from '../types';

/** Keep slash variants equivalent without masking a real file rename. */
const normalize = (href: string) => href.replace(/^\//, '').replace(/^docs\//, '');

export function collectNavHrefs(items: NavItem[]): string[] {
  return items.flatMap(item => [...(item.href ? [item.href] : []), ...(item.children ? collectNavHrefs(item.children) : [])]);
}

export function droppedNavHrefs(current: string[], proposed: string[], remove: string[] = []): string[] {
  const permitted = new Set([...proposed, ...remove].map(normalize));
  return [...new Set(current.filter(href => !permitted.has(normalize(href))))];
}

/** Parse only the navigation block; unrelated custom YAML tags remain untouched. */
export function mkdocsNavHrefs(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex(line => /^nav\s*:/.test(line));
  if (start < 0) throw new Error('This configuration uses automatic navigation. Define a complete explicit nav in GitHub before replacing it here.');
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]) || /^#/.test(lines[end]))) end++;
  const document = parseDocument(lines.slice(start, end).join('\n'), { strict: true, uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error('The current navigation cannot be safely parsed. Resolve its YAML tags, aliases or syntax in GitHub first.');
  const nav = document.toJS({ maxAliasCount: 25 })?.nav;
  if (!Array.isArray(nav)) throw new Error('The current navigation must be an explicit list before it can be safely replaced.');
  const hrefs: string[] = [];
  function visit(value: unknown): void {
    if (typeof value === 'string') { hrefs.push(value); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value && typeof value === 'object') { Object.values(value).forEach(visit); return; }
    throw new Error('The current navigation contains an unsupported value. Edit it in GitHub first.');
  }
  nav.forEach(visit);
  return hrefs;
}
