export type HelpSection = {
  /** Heading text without leading `## `, or empty for the document preamble. */
  title: string
  /** Full markdown for this section (includes the `##` heading when present). */
  markdown: string
}

/** Split a help markdown document into the preamble and `##` sections. */
export function splitHelpSections(document: string): HelpSection[] {
  const text = document.replace(/^\uFEFF/, '').trimEnd()
  if (!text.trim()) return []

  const lines = text.split(/\r?\n/)
  const sections: HelpSection[] = []
  let title = ''
  let buffer: string[] = []

  const flush = () => {
    const markdown = buffer.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
    if (!markdown.trim() && !title) return
    sections.push({ title, markdown })
    buffer = []
  }

  for (const line of lines) {
    // Top-level `##` only (`###` keeps the current section).
    if (line.startsWith('## ')) {
      flush()
      title = line.slice(3).trim()
      buffer = [line]
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections
}

/** Case-insensitive filter: keep sections whose title or body contains the query. */
export function filterHelpSections(sections: HelpSection[], query: string): HelpSection[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return sections
  return sections.filter(section => {
    const haystack = `${section.title}\n${section.markdown}`.toLocaleLowerCase()
    return haystack.includes(needle)
  })
}

/** Join filtered sections back into a single markdown document. */
export function joinHelpSections(sections: HelpSection[]): string {
  return sections
    .map(s => s.markdown)
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Heading id matching the help TOC anchors (GitHub-style):
 * lowercase, punctuation stripped, spaces → `-`.
 * e.g. "Git 源代码管理" → "git-源代码管理"
 */
export function helpHeadingId(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

/** Flatten React-ish children / markdown text nodes into a plain string. */
export function flattenText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props
    return flattenText(props?.children)
  }
  return ''
}
