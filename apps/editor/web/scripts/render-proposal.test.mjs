import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { escapeHtml, renderProposal } from './render-proposal.mjs'

const brandDir = process.cwd()

test('escapes hostile text and raw HTML while retaining safe Markdown formatting', async () => {
  const html = await renderProposal({
    title: '<proposal>', brand: { name: '<img src=x onerror=alert(1)>' }, brandDir,
    markdown: '# Hello <script>alert(1)</script>\n\n<b>unsafe</b> **safe**\n\n[bad](javascript:alert(1)) [good](https://example.com)',
  })
  assert.match(html, /&lt;proposal&gt;/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&lt;b&gt;unsafe&lt;\/b&gt; <strong>safe<\/strong>/)
  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /href="https:\/\/example\.com\/"/)
  assert.match(html, /default-src 'none'; img-src data:/)
})

test('renders reusable components, tables, page breaks, and safe brand tokens', async () => {
  const html = await renderProposal({
    title: 'Example', brand: { colors: { primary: '#123456; color:red' }, fonts: { body: 'url(https://bad)' } }, brandDir,
    markdown: ':::summary\nSummary **content**\n:::\n\n:::pricing\n| Item | Price |\n| --- | ---: |\n| Work | $10 |\n:::\n\n:::total\nTotal | $10\n:::\n\n:::pagebreak\n:::\n\n:::signature\nClient\n:::',
  })
  assert.match(html, /class="proposal-summary"/)
  assert.match(html, /class="proposal-pricing"/)
  assert.match(html, /<table>/)
  assert.match(html, /class="proposal-total"/)
  assert.match(html, /class="proposal-pagebreak"/)
  assert.match(html, /class="proposal-signature"/)
  assert.match(html, /--proposal-primary:#17324D/)
  assert.match(html, /--proposal-body:Arial, sans-serif/)
  assert.match(html, /@page \{ size: A4;/)
  await assert.rejects(() => renderProposal({ title: 'x', markdown: ':::unknown\nno\n:::', brand: {}, brandDir }), /Unsupported proposal component/)
})

test('accepts only contained raster logo files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fdocs-proposal-'))
  const outside = join(dir, 'outside.png')
  const config = join(dir, 'brand')
  await mkdir(config)
  await writeFile(outside, Buffer.from([137, 80, 78, 71]))
  await symlink(outside, join(config, 'escape.png'))
  await writeFile(join(config, 'mark.png'), Buffer.from([137, 80, 78, 71]))
  const html = await renderProposal({ title: 'x', markdown: '# x', brand: { name: 'Test', logo: 'mark.png' }, brandDir: config })
  assert.match(html, /data:image\/png;base64,/)
  await assert.rejects(() => renderProposal({ title: 'x', markdown: '', brand: { logo: '../outside.png' }, brandDir: config }), /invalid path segment/)
  await assert.rejects(() => renderProposal({ title: 'x', markdown: '', brand: { logo: 'escape.png' }, brandDir: config }), /inside the brand configuration directory/)
  await assert.rejects(() => renderProposal({ title: 'x', markdown: '', brand: { logo: 'https://example.com/logo.png' }, brandDir: config }), /relative local file path/)
  await assert.rejects(() => renderProposal({ title: 'x', markdown: '', brand: { logo: 'mark.svg' }, brandDir: config }), /PNG, JPEG, or WebP/)
})

test('HTML escaping covers all attribute and text delimiters', () => {
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;')
})
