import type { Proposal } from '../model'

/** Create a printable review document without interpreting proposal text as HTML. */
export function printProposal(repo: string, path: string, source: string, proposal: Proposal) {
  const target = window.open('', '_blank')
  if (!target) throw new Error('Allow pop-ups to open the printable proposal.')
  target.opener = null
  const doc = target.document
  doc.title = `Proposal — ${repo}/${path}`
  const style = doc.createElement('style')
  style.textContent = `@page{size:A4;margin:18mm}body{font:11pt/1.5 system-ui,sans-serif;max-width:190mm;margin:24px auto;padding:0 16px;color:#18202b}h1{font-size:22pt}h2{font-size:14pt;break-after:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:9pt/1.5 monospace;border:1px solid #ccc;padding:12px}header{border-bottom:2px solid #18202b;padding-bottom:12px}.metadata{overflow-wrap:anywhere;color:#465264}.review{border:1px solid #aaa;padding:12px;margin:24px 0}@media print{button{display:none}body{padding:0;margin:0}}`
  doc.head.append(style)
  const node = (tag: string, text: string, parent: HTMLElement = doc.body) => {
    const el = doc.createElement(tag); el.textContent = text; parent.append(el); return el
  }
  const header = node('header', '')
  node('p', 'FreeDocStore · Proposal review', header)
  node('h1', proposal.summary, header)
  node('p', `${repo} / ${path}\n${new Date().toLocaleString()}`, header).className = 'metadata'
  node('h2', 'Reason for the change')
  node('p', proposal.rationale || 'No additional rationale supplied.')
  const review = node('section', '')
  review.className = 'review'
  node('strong', 'Review decision', review)
  node('p', '☐ Approve   ☐ Request changes   ☐ Reject', review)
  node('p', 'Reviewer: ____________________    Date: ______________', review)
  node('p', 'Notes: ___________________________________________________', review)
  node('h2', 'Current source'); node('pre', source)
  node('h2', 'Proposed source'); node('pre', proposal.content)
  const button = node('button', 'Print / Save as PDF') as HTMLButtonElement
  button.type = 'button'; button.onclick = () => target.print()
  target.focus()
}
