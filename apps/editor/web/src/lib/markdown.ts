import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: false })

/** Render Markdown to sanitized HTML for the rendered preview. */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md ?? '', { async: false }) as string
  return DOMPurify.sanitize(raw)
}
