import { starterPublish } from './settings'
import type {
  EditForm,
  KnowledgeBaseDraft,
  PublishForm,
  PublishStep,
  RegistryKb,
  RepoFile,
  StepState,
} from './types'
import { normalizeDomain, nowIso, setTomlScalar, slugify, upsertFile } from './util'

export const initialSteps: PublishStep[] = [
  { id: 'plan', label: 'Plan', detail: 'Create Zensical structure', state: 'idle' },
  { id: 'ai', label: 'Draft', detail: 'Generate Markdown files', state: 'idle' },
  { id: 'repo', label: 'Repo', detail: 'Create GitHub repository', state: 'idle' },
  { id: 'files', label: 'Files', detail: 'Commit Zensical source', state: 'idle' },
  { id: 'registry', label: 'Registry', detail: 'Register in the public library', state: 'idle' },
  { id: 'deploy', label: 'Deploy', detail: 'GitHub Actions publishes to Cloudflare', state: 'idle' },
]

export function cloneSteps() {
  return initialSteps.map((step) => ({ ...step }))
}

export function createKnowledgeBase(form: PublishForm): KnowledgeBaseDraft {
  const timestamp = nowIso()
  return {
    ...form,
    customDomain: normalizeDomain(form.customDomain),
    id: crypto.randomUUID(),
    files: [],
    liveUrl: '',
    repoUrl: '',
    lastStatus: 'Draft',
    createdAt: timestamp,
    updatedAt: timestamp,
    steps: cloneSteps(),
  }
}

export function normalizeKnowledgeBase(value: Partial<KnowledgeBaseDraft> & PublishForm): KnowledgeBaseDraft {
  const base = createKnowledgeBase({ ...starterPublish, ...value })
  return {
    ...base,
    id: value.id || base.id,
    files: Array.isArray(value.files) ? value.files : [],
    liveUrl: value.liveUrl || '',
    repoUrl: value.repoUrl || '',
    lastStatus: value.lastStatus || 'Draft',
    createdAt: value.createdAt || base.createdAt,
    updatedAt: value.updatedAt || base.updatedAt,
    steps: Array.isArray(value.steps) && value.steps.length ? value.steps : cloneSteps(),
  }
}

export function toPublishForm(kb: KnowledgeBaseDraft): PublishForm {
  return {
    title: kb.title,
    slug: kb.slug,
    owner: kb.owner,
    customDomain: kb.customDomain,
    visibility: kb.visibility,
    prompt: kb.prompt,
  }
}

export function livePageUrl(library: RegistryKb[], form: Pick<EditForm, 'repo' | 'path'>): string | null {
  const kb = library.find((entry) => entry.source.repo.toLowerCase() === form.repo.trim().toLowerCase())
  const base = kb?.cloudflare?.production_url
  if (!base) return null
  let rel = form.path.trim().replace(/^docs\//, '')
  if (rel === 'index.md' || rel === '') rel = ''
  else if (rel.endsWith('/index.md')) rel = rel.slice(0, -'index.md'.length)
  else rel = rel.replace(/\.md$/, '/')
  try {
    return new URL(rel, base).toString()
  } catch {
    return null
  }
}

export const KB_DOMAIN_SUFFIX = 'freedocstore.online'

export function liveTargetFor(form: Pick<PublishForm, 'slug' | 'customDomain'>) {
  return form.customDomain ? `https://${form.customDomain}/` : `https://${form.slug}.${KB_DOMAIN_SUFFIX}/`
}

export function nextAvailableSlug(kbs: KnowledgeBaseDraft[], desired: string) {
  const base = slugify(desired) || 'knowledge-base'
  const used = new Set(kbs.map((kb) => kb.slug))
  if (!used.has(base)) return base
  // Keep suffixed candidates within the 58-char slug limit validatePublishForm
  // enforces: trim the base so `${base}${suffix}` never exceeds it.
  const withSuffix = (suffix: string) => `${base.slice(0, 58 - suffix.length)}${suffix}`
  for (let i = 2; i < 1000; i++) {
    const candidate = withSuffix(`-${i}`)
    if (!used.has(candidate)) return candidate
  }
  return withSuffix(`-${Date.now()}`)
}

export function deployWorkflow(project: string, customDomain: string) {
  const domains = [`${project}.${KB_DOMAIN_SUFFIX}`, ...(customDomain ? [customDomain] : [])].join(' ')
  return `name: Deploy Zensical KB

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  deployments: write

concurrency:
  group: deploy-zensical
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - run: python -m pip install zensical
      - run: python -m zensical build --strict
      - name: Inject FreeDocStore source metadata
        run: |
          node <<'NODE'
          const fs = require('node:fs');
          const path = require('node:path');

          const repo = process.env.GITHUB_REPOSITORY;
          if (!repo) throw new Error('GITHUB_REPOSITORY is not set');

          const siteDir = 'site';
          const docsDir = 'docs';
          const sourceExts = ['.md', '.mdx', '.markdown', '.html', '.htm'];

          function walk(dir) {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
              const full = path.join(dir, entry.name);
              return entry.isDirectory() ? walk(full) : [full];
            });
          }

          function escapeAttr(value) {
            return String(value)
              .replace(/&/g, '&amp;')
              .replace(/"/g, '&quot;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
          }

          function sourceForHtml(file) {
            let rel = path.relative(siteDir, file).split(path.sep).join('/');
            if (rel === 'index.html') rel = 'index';
            else if (rel.endsWith('/index.html')) rel = rel.slice(0, -'/index.html'.length);
            else rel = rel.replace(/\.html?$/i, '');
            const candidates = sourceExts.map((ext) => path.posix.join(docsDir, rel + ext));
            return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
          }

          for (const file of walk(siteDir).filter((candidate) => /\.html?$/i.test(candidate))) {
            let html = fs.readFileSync(file, 'utf8');
            html = html.replace(/<meta\s+[^>]*name=["']source-repo["'][^>]*>\s*/gi, '');
            html = html.replace(/<meta\s+[^>]*name=["']source-path["'][^>]*>\s*/gi, '');
            const sourcePath = sourceForHtml(file);
            const meta = [
              '<meta name="source-repo" content="' + escapeAttr(repo) + '">',
              '<meta name="source-path" content="' + escapeAttr(sourcePath) + '">',
            ].join('\\n      ');
            if (/<head[^>]*>/i.test(html)) {
              html = html.replace(/<head([^>]*)>/i, '<head$1>\\n      ' + meta);
            } else {
              html = meta + '\\n' + html;
            }
            fs.writeFileSync(file, html);
          }
          NODE
      - name: Ensure Cloudflare Pages project
        run: npx wrangler pages project create "${project}" --production-branch=main || true
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: Deploy to Cloudflare Pages
        run: npx wrangler pages deploy site --project-name="${project}" --branch=main
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: Attach domains
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PROJECT: ${project}
          DOMAINS: ${domains}
        run: |
          set -e
          api() { curl -sS -H "Authorization: Bearer \$CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "\$@"; }
          for DOMAIN in \$DOMAINS; do
            api -X POST "https://api.cloudflare.com/client/v4/accounts/\$CLOUDFLARE_ACCOUNT_ID/pages/projects/\$PROJECT/domains" \\
              --data "{\\"name\\":\\"\$DOMAIN\\"}" > /dev/null || true
            ZONE="\${DOMAIN#*.}"
            ZONE_ID=\$(api "https://api.cloudflare.com/client/v4/zones?name=\$ZONE" | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print(r[0]["id"] if r else "")')
            [ -z "\$ZONE_ID" ] && { echo "No zone for \$DOMAIN, skipping"; continue; }
            EXISTS=\$(api "https://api.cloudflare.com/client/v4/zones/\$ZONE_ID/dns_records?type=CNAME&name=\$DOMAIN" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["result"]))')
            if [ "\$EXISTS" = "0" ]; then
              api -X POST "https://api.cloudflare.com/client/v4/zones/\$ZONE_ID/dns_records" \\
                --data "{\\"type\\":\\"CNAME\\",\\"name\\":\\"\$DOMAIN\\",\\"content\\":\\"\$PROJECT.pages.dev\\",\\"proxied\\":true}" > /dev/null
            fi
            echo "Ensured \$DOMAIN"
          done
`
}

export function ensureFallbackFiles(files: RepoFile[], form: PublishForm, workflow: string): RepoFile[] {
  let next = [...files]
  const siteUrl = liveTargetFor(form)
  next = upsertFile(next, '.github/workflows/deploy.yml', workflow)
  next = upsertFile(next, '.gitignore', 'site/\n.cache/\n.DS_Store\n')
  if (!next.some((file) => file.path === 'README.md')) {
    next.push({ path: 'README.md', content: `# ${form.title}\n\nFreeDocStore Zensical knowledge base.\n\nSource lives in \`docs/\` and builds with \`python -m zensical build --strict\`.\n` })
  }
  const zensicalIndex = next.findIndex((file) => file.path === 'zensical.toml')
  if (zensicalIndex >= 0) {
    next[zensicalIndex] = {
      ...next[zensicalIndex],
      content: setTomlScalar(setTomlScalar(next[zensicalIndex].content, 'site_url', siteUrl), 'repo_url', `https://github.com/${form.owner}/${form.slug}`),
    }
  } else {
    next.push({
      path: 'zensical.toml',
      content: `site_name = "${form.title.replace(/"/g, '\\"')}"\nsite_url = "${siteUrl}"\nrepo_url = "https://github.com/${form.owner}/${form.slug}"\ndocs_dir = "docs"\nsite_dir = "site"\n\n[nav]\nitems = [\n  { title = "Overview", path = "index.md" },\n  { title = "First Principles", path = "first-principles.md" },\n  { title = "Assessment Method", path = "assessment-method.md" },\n  { title = "Register", path = "register.md" },\n]\n`,
    })
  }
  if (!next.some((file) => file.path === 'docs/index.md')) {
    next.push({ path: 'docs/index.md', content: `# ${form.title}\n\n${form.prompt}\n` })
  }
  return next.sort((a, b) => a.path.localeCompare(b.path))
}

export function resetSteps(active: string, state: StepState) {
  return initialSteps.map((step) => ({ ...step, state: step.id === active ? state : 'idle' as StepState }))
}

export function updateStep(id: string, state: StepState, detail: string) {
  return (prev: PublishStep[]) => prev.map((step) => (step.id === id ? { ...step, state, detail } : step))
}

export function markCurrentError(current: PublishStep[]) {
  const busy = current.find((step) => step.state === 'busy')
  if (!busy) return current
  return current.map((step) => (step.id === busy.id ? { ...step, state: 'error' as StepState } : step))
}
