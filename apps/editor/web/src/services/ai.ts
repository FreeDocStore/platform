import { fds as app } from '../lib/fds'
import {
  AI_PROVIDERS,
  type AiUsage,
  type EditForm,
  type Proposal,
  type PublishForm,
  type RepoFile,
  type Settings,
  deployWorkflow,
  ensureFallbackFiles,
  liveTargetFor,
  parseJson,
  proxyTarget,
  upsertFile,
} from '../model'

export async function generateKbFiles(settings: Settings, form: PublishForm): Promise<{ files: RepoFile[]; usage: AiUsage | null }> {
  const workflow = deployWorkflow(form.slug, form.customDomain)
  const system = [
    'You generate FreeDocStore knowledge bases.',
    'Only output GitHub repo source files for a Zensical project.',
    'Do not output generated HTML or static site output.',
    'Use Markdown under docs/, zensical.toml at the repo root, and a concise README.',
    'Return only JSON: {"files":[{"path":"...","content":"..."}]}',
  ].join(' ')
  const user = [
    `Title: ${form.title}`,
    `Slug: ${form.slug}`,
    `Production URL: ${liveTargetFor(form)}`,
    form.customDomain ? `Custom domain: https://${form.customDomain}/` : 'Custom domain: none',
    '',
    'Required files:',
    '- README.md',
    '- .gitignore',
    '- zensical.toml',
    '- docs/index.md',
    '- docs/first-principles.md',
    '- docs/assessment-method.md',
    '- docs/register.md',
    '',
    'Knowledge-base prompt:',
    form.prompt,
  ].join('\n')
  const { text, usage } = await callAi(settings, system, user)
  const parsed = parseJson(text) as { files?: RepoFile[] }
  const aiFiles = Array.isArray(parsed.files) ? parsed.files : []
  const normalized = aiFiles
    .filter((file) => typeof file.path === 'string' && typeof file.content === 'string')
    .map((file) => ({ path: file.path.replace(/^\/+/, ''), content: file.content }))
    .filter((file) => !file.path.startsWith('site/') && !file.path.endsWith('.html'))
  const withRequired = upsertFile(normalized, '.github/workflows/deploy.yml', workflow)
  return { files: ensureFallbackFiles(withRequired, form, workflow), usage }
}

export async function generateEditProposal(settings: Settings, form: EditForm, current: string): Promise<{ proposal: Proposal; usage: AiUsage | null }> {
  const system = [
    'You are an AI-first Markdown knowledge-base editor.',
    'Return a complete replacement for the file, not a patch.',
    'Preserve truthful facts and formatting unless the request changes them.',
    'Do not invent dates, legal claims, prices, or product capabilities.',
    'Return only JSON: {"summary":"...","rationale":"...","content":"..."}',
  ].join(' ')
  const user = [`Path: ${form.path}`, '', 'Current source:', '```', current, '```', '', 'Request:', form.instruction].join('\n')
  const { text, usage } = await callAi(settings, system, user)
  const parsed = parseJson(text) as Proposal
  if (!parsed.content?.trim()) throw new Error('AI response did not include replacement content.')
  return { proposal: parsed, usage }
}

export async function pingAi(settings: Settings): Promise<{ ok: boolean; error: string }> {
  try {
    await callAi(settings, 'Return only JSON.', '{"ok":true}')
    return { ok: true, error: '' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function usageFrom(data: any): AiUsage | null {
  const u = data?.usage
  if (!u) return null
  const prompt = u.prompt_tokens ?? u.input_tokens ?? 0
  const completion = u.completion_tokens ?? u.output_tokens ?? 0
  return { prompt, completion, total: u.total_tokens ?? prompt + completion }
}

export async function callAi(settings: Settings, system: string, user: string): Promise<{ text: string; usage: AiUsage | null }> {
  const spec = AI_PROVIDERS[settings.provider]
  if (settings.provider === 'anthropic') {
    const res = await app.proxy.fetch(proxyTarget(spec.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 8192,
        system: `${system} Output only the raw JSON object with no surrounding prose or markdown fences.`,
        messages: [{ role: 'user', content: user }],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`)
    const data = await res.json()
    const text = data?.content?.[0]?.text
    if (typeof text !== 'string') throw new Error('Anthropic returned no content.')
    return { text, usage: usageFrom(data) }
  }
  const isGithub = settings.provider === 'github'
  const res = await app.proxy.fetch(proxyTarget(spec.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      // GitHub Models' catalog is broader than OpenAI JSON mode; rely on the prompt
      // + parseJson there, and only ask real OpenAI for strict json_object mode.
      ...(isGithub ? {} : { response_format: { type: 'json_object' } }),
      messages: [
        { role: 'system', content: isGithub ? `${system} Output only the raw JSON object, no prose or code fences.` : system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    if (isGithub && (res.status === 429 || res.status === 403)) {
      throw new Error(`GitHub Models free limit reached (${res.status}). Add your own OpenAI or Anthropic key in Profile → API keys to keep going, then switch the AI provider.`)
    }
    throw new Error(`${isGithub ? 'GitHub Models' : 'OpenAI'} request failed: ${res.status} ${body}`)
  }
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error(`${isGithub ? 'GitHub Models' : 'OpenAI'} returned no content.`)
  return { text: content, usage: usageFrom(data) }
}
