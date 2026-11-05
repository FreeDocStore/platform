#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function cloudflareClient({ token, fetch: request = fetch }) {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  return async (route, { method = 'GET', body, allowMissing = false } = {}) => {
    const response = await request(`https://api.cloudflare.com/client/v4${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (allowMissing && response.status === 404) return null;
    const data = await response.json();
    if (!response.ok || data.success !== true) throw new Error(`Cloudflare ${method} ${route} failed (${response.status}); check the token permissions and hosting configuration.`);
    return data.result;
  };
}

export async function ensureProject(api, account, project) {
  const route = `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(project)}`;
  const existing = await api(route, { allowMissing: true });
  if (existing) {
    if (existing.production_branch !== 'main') throw new Error('The Pages project must use main as its production branch.');
    return;
  }
  await api(`/accounts/${encodeURIComponent(account)}/pages/projects`, { method: 'POST', body: { name: project, production_branch: 'main' } });
}

export async function ensureDomains(api, account, project, domains, report = console.log) {
  const route = `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(project)}/domains`;
  const attached = await api(route);
  if (!Array.isArray(attached)) throw new Error('Invalid Pages domains response');
  for (const domain of domains) {
    if (!attached.some(entry => entry.name === domain)) await api(route, { method: 'POST', body: { name: domain } });
    // A custom domain may itself be a zone apex, or belong to a parent zone.
    const labels = domain.split('.');
    let zone;
    for (let i = 0; i < labels.length - 1; i++) {
      const zones = await api(`/zones?name=${encodeURIComponent(labels.slice(i).join('.'))}`);
      if (!Array.isArray(zones)) throw new Error('Invalid DNS zones response');
      if (zones.length) { zone = zones[0]; break; }
    }
    if (!zone) {
      report(`Domain attached: ${domain}. Configure external DNS to ${project}.pages.dev and verify domain activation in Cloudflare.`);
      continue;
    }
    const dns = `/zones/${encodeURIComponent(zone.id)}/dns_records`;
    const existing = await api(`${dns}?name=${encodeURIComponent(domain)}`);
    if (!Array.isArray(existing)) throw new Error('Invalid DNS records response');
    const target = `${project}.pages.dev`;
    if (existing.length && !existing.some(record => record.type === 'CNAME' && record.content.toLowerCase().replace(/\.$/, '') === target)) throw new Error(`DNS for ${domain} points elsewhere. Review existing records before publishing.`);
    if (!existing.length) await api(dns, { method: 'POST', body: { type: 'CNAME', name: domain, content: target, proxied: true } });
    report(`Domain and DNS configured: ${domain}. Verify domain activation in Cloudflare.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, PROJECT: project, DOMAINS: domains = '' } = process.env;
  if (!account || !project) throw new Error('CLOUDFLARE_ACCOUNT_ID and PROJECT are required');
  const api = cloudflareClient({ token });
  const mode = process.argv[2];
  if (mode === 'project') await ensureProject(api, account, project);
  else if (mode === 'domains') await ensureDomains(api, account, project, domains.split(/\s+/).filter(Boolean));
  else throw new Error('Usage: node cloudflare.mjs <project|domains>');
}
