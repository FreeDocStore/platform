import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { Marked, Renderer } from 'marked'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const cssPath = resolve(repoRoot, 'templates/proposals/proposal.css')
const logoMime = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']])

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function safeColor(value, fallback) {
  return typeof value === 'string' && /^#[\da-fA-F]{6}$/.test(value) ? value : fallback
}

function safeFont(value, fallback) {
  if (typeof value !== 'string' || value.length > 100 || /[;{}<>\\]|url\s*\(|@import/i.test(value)) return fallback
  const families = value.split(',').map(part => part.trim())
  if (families.some(part => !/^(?:[\w -]+|"[\w -]+"|'[\w -]+')$/.test(part))) return fallback
  return families.join(', ')
}

function validateBrand(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Brand configuration must be a JSON object.')
  const colors = raw.colors && typeof raw.colors === 'object' ? raw.colors : {}
  const fonts = raw.fonts && typeof raw.fonts === 'object' ? raw.fonts : {}
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 100) : 'Proposal',
    logo: raw.logo,
    colors: {
      primary: safeColor(colors.primary, '#17324D'), accent: safeColor(colors.accent, '#D27A42'),
      text: safeColor(colors.text, '#243244'), muted: safeColor(colors.muted, '#657487'), rule: safeColor(colors.rule, '#D8E0E8'),
    },
    fonts: { body: safeFont(fonts.body, 'Arial, sans-serif'), heading: safeFont(fonts.heading, 'Georgia, serif') },
  }
}

async function resolveLocalResource(baseDir, resource) {
  if (typeof resource !== 'string' || !resource.trim() || isAbsolute(resource) || /^[a-z][a-z\d+.-]*:/i.test(resource) || resource.includes('\\')) {
    throw new Error('Logo must be a relative local file path.')
  }
  const segments = resource.split('/')
  if (segments.some(part => !part || part === '.' || part === '..')) throw new Error('Logo path contains an invalid path segment.')
  const requestedExtension = extname(resource).toLowerCase()
  if (!logoMime.has(requestedExtension)) throw new Error('Logo must be a PNG, JPEG, or WebP image.')
  const candidate = resolve(baseDir, resource)
  const resolvedBase = await realpath(baseDir)
  const resolvedCandidate = await realpath(candidate)
  const rel = relative(resolvedBase, resolvedCandidate)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Logo path must stay inside the brand configuration directory.')
  const extension = extname(resolvedCandidate).toLowerCase()
  const mime = logoMime.get(extension)
  if (!mime) throw new Error('Logo must be a PNG, JPEG, or WebP image.')
  const details = await stat(resolvedCandidate)
  if (!details.isFile() || details.size > 2 * 1024 * 1024) throw new Error('Logo must be a local image no larger than 2 MiB.')
  return `data:${mime};base64,${(await readFile(resolvedCandidate)).toString('base64')}`
}

function safeHref(href) {
  try {
    const url = new URL(href)
    return ['https:', 'mailto:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function convertComponents(markdown) {
  const allowed = new Set(['summary', 'scope', 'pricing', 'total', 'signature', 'pagebreak'])
  const components = []
  const text = markdown.replace(/^:::(\w+)\s*\n([\s\S]*?)^:::\s*$/gm, (_whole, name, body) => {
    if (!allowed.has(name)) throw new Error(`Unsupported proposal component: ${name}`)
    const token = `FDS_PROPOSAL_COMPONENT_${components.length}_TOKEN`
    components.push({ token, name, body })
    return `\n\n${token}\n\n`
  })
  return { text, components }
}

export async function renderProposal({ markdown, title, brand, brandDir }) {
  const normalized = validateBrand(brand)
  let logo = ''
  if (normalized.logo !== undefined && normalized.logo !== '') {
    const data = await resolveLocalResource(brandDir, normalized.logo)
    logo = `<img alt="${escapeHtml(normalized.name)}" src="${data}">`
  }
  const renderer = new Renderer()
  renderer.html = ({ text }) => escapeHtml(text)
  renderer.link = function ({ href, title: linkTitle, tokens }) {
    const label = this.parser.parseInline(tokens)
    const safe = safeHref(href)
    return safe ? `<a href="${escapeHtml(safe)}"${linkTitle ? ` title="${escapeHtml(linkTitle)}"` : ''} rel="noreferrer">${label}</a>` : label
  }
  renderer.image = ({ text }) => escapeHtml(text)
  const parser = new Marked({ gfm: true, breaks: false, renderer })
  const converted = convertComponents(markdown)
  let body = await parser.parse(converted.text)
  for (const component of converted.components) {
    let html
    if (component.name === 'pagebreak') html = '<div class="proposal-pagebreak" aria-hidden="true"></div>'
    else if (component.name === 'total') {
      const [label, amount] = component.body.trim().split(/\s*\|\s*/)
      html = `<div class="proposal-total"><span>${parser.parseInline(label || '')}</span><strong>${parser.parseInline(amount || '')}</strong></div>`
    } else {
      const inner = await parser.parse(component.body)
      html = `<section class="proposal-${component.name}">${inner}</section>`
    }
    body = body.replace(`<p>${component.token}</p>`, html)
  }
  const css = await readFile(cssPath, 'utf8')
  const variables = `:root{--proposal-primary:${normalized.colors.primary};--proposal-accent:${normalized.colors.accent};--proposal-text:${normalized.colors.text};--proposal-muted:${normalized.colors.muted};--proposal-rule:${normalized.colors.rule};--proposal-body:${normalized.fonts.body};--proposal-heading:${normalized.fonts.heading}}`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>${variables}\n${css}</style></head><body><header class="brand">${logo}<span class="brand-name">${escapeHtml(normalized.name)}</span></header><main>${body}</main></body></html>`
}

async function findHeadlessShell() {
  const home = process.env.HOME || tmpdir()
  const cache = process.platform === 'darwin'
    ? resolve(home, 'Library/Caches/ms-playwright')
    : process.platform === 'win32'
      ? resolve(process.env.LOCALAPPDATA || home, 'ms-playwright')
      : resolve(home, '.cache/ms-playwright')
  const platform = process.platform === 'darwin' ? `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : process.platform === 'win32' ? 'win64' : 'linux64'
  let entries
  try { entries = await readdir(cache) } catch { return null }
  const candidates = entries.filter(name => name.startsWith('chromium_headless_shell-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const candidate of candidates) {
    const executable = resolve(cache, candidate, `chrome-headless-shell-${platform}`, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell')
    try { if ((await stat(executable)).isFile()) return executable } catch { /* try the next installed browser */ }
  }
  return null
}

export async function renderPdf(htmlPath, pdfPath, chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') {
  const profile = await mkdtemp(resolve(tmpdir(), 'fdocs-proposal-chrome-'))
  try {
    const executable = process.env.CHROME_BIN || await findHeadlessShell() || chromePath
    await execFileAsync(executable, [
      '--headless', '--no-first-run', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--disable-sync', '--disable-file-access-from-files', '--no-pdf-header-footer', `--user-data-dir=${profile}`,
      `--print-to-pdf=${pdfPath}`, pathToFileURL(resolve(htmlPath)).href,
    ], { timeout: 60_000, maxBuffer: 1024 * 1024 })
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!['--input', '--output', '--brand', '--format'].includes(key) || !argv[index + 1]) throw new Error(`Invalid or incomplete argument: ${key}`)
    result[key.slice(2)] = argv[++index]
  }
  if (!result.input || !result.output) throw new Error('Usage: node scripts/render-proposal.mjs --input FILE.md --output FILE.html|FILE.pdf [--brand brand.json] [--format html|pdf]')
  result.format ||= extname(result.output).slice(1).toLowerCase()
  if (!['html', 'pdf'].includes(result.format)) throw new Error('Output format must be html or pdf.')
  if (extname(result.output).slice(1).toLowerCase() !== result.format) throw new Error('Output extension must match the selected format.')
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const input = resolve(args.input)
  const output = resolve(args.output)
  const inputReal = await realpath(input)
  if (inputReal === output) throw new Error('Output must not overwrite the Markdown input.')
  const brandPath = args.brand ? resolve(args.brand) : null
  const brand = brandPath ? JSON.parse(await readFile(brandPath, 'utf8')) : {}
  const html = await renderProposal({ markdown: await readFile(inputReal, 'utf8'), title: basename(input, extname(input)), brand, brandDir: brandPath ? dirname(await realpath(brandPath)) : dirname(inputReal) })
  if (args.format === 'html') {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(output, html, { flag: 'wx' })
  } else {
    const temporaryHtml = `${output}.${process.pid}.html`
    const { writeFile, unlink, open } = await import('node:fs/promises')
    const reservation = await open(output, 'wx')
    await reservation.close()
    await writeFile(temporaryHtml, html, { flag: 'wx' })
    try {
      await renderPdf(temporaryHtml, output)
      if ((await stat(output)).size < 1000) throw new Error('Browser produced an empty or incomplete PDF.')
    } catch (error) {
      await unlink(output).catch(() => {})
      throw error
    } finally { await unlink(temporaryHtml).catch(() => {}) }
  }
  console.log(`Rendered ${args.format}: ${output}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Proposal rendering failed: ${error.message}`); process.exitCode = 1 })
}
