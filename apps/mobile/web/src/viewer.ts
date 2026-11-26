// 只读文件 / 差异查看的纯逻辑：fs.read 结果归一化、分段续读、行号、统一 diff 着色。
import { isImagePath } from './fileLinks'
import { errorCode, friendlyError } from './state'

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** 手机上一次只拉 512 KiB：首屏快，DOM 行数可控；需要时"加载更多"。 */
export const READ_CHUNK_BYTES = 512 * 1024
/** 差异超过这么多行只显示前面部分，避免低端机卡死。 */
export const MAX_DIFF_ROWS = 5000

/** 对应 protocol FsReadResult 的手机端子集（不跨包 import）。 */
export type FsReadView = {
  path: string
  content: string
  encoding: 'utf8' | 'base64'
  size: number
  offset: number
  length: number
  truncated: boolean
  binary: boolean
}

export function parseFsRead(value: unknown, fallbackPath = ''): FsReadView | null {
  if (!isRecord(value) || typeof value.content !== 'string') return null
  const offset = num(value.offset)
  const length = num(value.length, value.content.length)
  const size = num(value.size, offset + length)
  return {
    path: typeof value.path === 'string' && value.path ? value.path : fallbackPath,
    content: value.content,
    encoding: value.encoding === 'base64' ? 'base64' : 'utf8',
    size,
    offset,
    length,
    truncated: typeof value.truncated === 'boolean' ? value.truncated : offset + length < size,
    binary: value.binary === true,
  }
}

/** 续读的下一个字节偏移。 */
export function nextOffset(view: FsReadView): number {
  return view.offset + view.length
}

/** 把续读结果拼到已加载内容后面；偏移不连续（文件已变化）时以新结果为准重来。 */
export function appendRead(prev: FsReadView, next: FsReadView): FsReadView {
  if (next.offset !== nextOffset(prev) || next.encoding !== prev.encoding) return next
  return {
    ...prev,
    content: prev.content + next.content,
    size: next.size,
    length: prev.length + next.length,
    truncated: next.truncated,
    binary: prev.binary || next.binary,
  }
}

export type ViewKind = 'text' | 'image' | 'binary'

export function viewKind(view: FsReadView): ViewKind {
  if (view.encoding === 'base64') return isImagePath(view.path) && view.content ? 'image' : 'binary'
  return view.binary ? 'binary' : 'text'
}

export type NumberedLine = { no: number; text: string }

/** 带行号的文本；末尾换行不额外算一行。 */
export function numberLines(content: string, start = 1): NumberedLine[] {
  if (!content) return []
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((text, index) => ({ no: start + index, text }))
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MiB`
  if (value >= 1024) return `${(value / 1024).toFixed(1).replace(/\.0$/, '')} KiB`
  return `${value} B`
}

export type DiffKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context'
export type DiffRow = { kind: DiffKind; text: string; oldNo?: number; newNo?: number }

export function classifyDiffLine(line: string): DiffKind {
  if (line.startsWith('@@')) return 'hunk'
  if (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('similarity ') ||
    line.startsWith('rename ') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('Binary files') ||
    line.startsWith('\\ No newline')
  ) {
    return 'meta'
  }
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  return 'context'
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** 统一 diff → 着色行，并按 hunk 头推算新旧行号。 */
export function diffRows(text: string, maxRows = MAX_DIFF_ROWS): { rows: DiffRow[]; truncated: boolean } {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.trim()) return { rows: [], truncated: false }
  const lines = normalized.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const line of lines.slice(0, maxRows)) {
    const kind = classifyDiffLine(line)
    if (kind === 'hunk') {
      const match = HUNK.exec(line)
      oldNo = match ? Number(match[1]) : 0
      newNo = match ? Number(match[2]) : 0
      inHunk = match !== null
      rows.push({ kind, text: line })
      continue
    }
    if (kind === 'meta' || !inHunk) {
      // hunk 之外的 +++/--- 等都是文件头；内容行只在 hunk 内计数。
      rows.push({ kind, text: line })
      continue
    }
    if (kind === 'add') rows.push({ kind, text: line, newNo: newNo++ })
    else if (kind === 'remove') rows.push({ kind, text: line, oldNo: oldNo++ })
    else rows.push({ kind, text: line, oldNo: oldNo++, newNo: newNo++ })
  }
  return { rows, truncated: lines.length > maxRows }
}

/** fs.read / git.diff 的错误码 → 手机上能看懂的话。 */
export function viewerError(err: unknown, fallback: string): string {
  switch (errorCode(err)) {
    case 'not_found':
      return '文件不存在或已被删除'
    case 'permission':
      return '没有权限读取该文件'
    case 'not_repo':
      return '该目录不在 Git 仓库中'
    case 'git_missing':
      return '目标机上未安装 git'
    case 'forbidden':
      return '电脑端版本过旧，暂不支持在手机上查看文件'
    default:
      return friendlyError(err, fallback)
  }
}
