/** Markdown 预览内查找：纯文本匹配 + DOM 文本节点 → Range 映射。 */

export type TextMatch = { from: number; to: number }

export type PreviewFindOptions = {
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
}

/** 与编辑器查找面板一致，超出后只显示 9999+。 */
export const PREVIEW_FIND_MAX_MATCHES = 10000

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 在纯文本中查找全部匹配。正则无效时返回 null（调用方显示无结果）。
 * 零长度匹配会被跳过，避免 `a*` 之类的正则死循环。
 */
export function findTextMatches(
  text: string,
  query: string,
  options: PreviewFindOptions,
): TextMatch[] | null {
  if (!query) return []
  let source = options.regexp ? query : escapeRegExp(query)
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
  let pattern: RegExp
  try {
    pattern = new RegExp(source, `gu${options.caseSensitive ? '' : 'i'}`)
  } catch {
    return null
  }
  const matches: TextMatch[] = []
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    if (found[0].length === 0) {
      pattern.lastIndex += 1
      continue
    }
    matches.push({ from: found.index, to: found.index + found[0].length })
    if (matches.length >= PREVIEW_FIND_MAX_MATCHES) break
  }
  return matches
}

export type TextSegments = {
  text: string
  nodes: { node: Text; start: number }[]
}

/** 收集根节点下所有可见文本节点，拼成一段文本并记录各节点起始偏移。 */
export function collectTextSegments(root: Node): TextSegments {
  const nodes: TextSegments['nodes'] = []
  let text = ''
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data
    if (!data) continue
    nodes.push({ node: node as Text, start: text.length })
    text += data
  }
  return { text, nodes }
}

/** 二分查找 offset 所在的文本节点（最后一个 start <= offset 的节点）。 */
function locate(segments: TextSegments, offset: number) {
  const { nodes } = segments
  let lo = 0
  let hi = nodes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (nodes[mid].start <= offset) lo = mid
    else hi = mid - 1
  }
  const entry = nodes[lo]
  return { node: entry.node, offset: offset - entry.start }
}

/** 把拼接文本里的匹配区间映射回 DOM Range（可跨文本节点）。 */
export function rangeForMatch(segments: TextSegments, match: TextMatch): Range | null {
  if (segments.nodes.length === 0) return null
  const start = locate(segments, match.from)
  // 终点按最后一个字符定位，再 +1，避免落到下一个节点的 0 偏移。
  const end = locate(segments, match.to - 1)
  const range = start.node.ownerDocument.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset + 1)
  return range
}

/** 请求在当前 Markdown 预览中打开查找浮层。 */
export const MARKDOWN_PREVIEW_FIND_EVENT = 'qingcode:markdown-preview-find'

export type MarkdownPreviewFindDetail = { seed: string }

/**
 * Ctrl+F 是否应打开预览内查找：焦点在预览窗格内（含查找浮层自身），
 * 或焦点落在 body 上且当前处于「仅预览」模式。
 */
export function isMarkdownPreviewFindTarget(target: EventTarget | null, doc: Document = document): boolean {
  if (typeof Element !== 'undefined' && target instanceof Element && target.closest('.qing-md-preview-pane')) {
    return true
  }
  const onBody = !target || target === doc.body || target === doc.documentElement || target === doc
  return onBody && Boolean(doc.querySelector('.qing-md-preview-pane[data-preview-only="true"]'))
}

/** 预览中当前选区文本（单行、≤100 字符）作为查找初始值。 */
export function markdownPreviewSelectionSeed(doc: Document = document): string {
  const selection = doc.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return ''
  const anchor = selection.getRangeAt(0).commonAncestorContainer
  const element = anchor instanceof Element ? anchor : anchor.parentElement
  if (!element?.closest('.qing-md-preview')) return ''
  const text = selection.toString()
  if (!text || text.length > 100 || /[\r\n]/.test(text)) return ''
  return text
}
