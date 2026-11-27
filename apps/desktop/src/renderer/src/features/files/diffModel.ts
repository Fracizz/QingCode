import { classifyDiffLine, type DiffLineKind } from '../../lib/diff'

export type DiffRow = {
  kind: DiffLineKind
  text: string
  oldLine: number | null
  newLine: number | null
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * 统一 diff → 带新旧行号的行；行号只从 @@ 头推进，文件头/元数据行不占号。
 */
export function parseUnifiedDiff(text: string): DiffRow[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const line of lines) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1]) || 0
      newLine = Number(hunk[2]) || 0
      inHunk = true
      rows.push({ kind: 'meta', text: line, oldLine: null, newLine: null })
      continue
    }
    // diff 头/文件头/无换行标记都不推进行号。
    if (!inHunk || /^(?:diff |index |---|\+\+\+|\\ )/.test(line)) {
      rows.push({ kind: classifyDiffLine(line), text: line, oldLine: null, newLine: null })
      continue
    }
    const kind = classifyDiffLine(line)
    if (kind === 'add') {
      rows.push({ kind, text: line, oldLine: null, newLine })
      newLine++
    } else if (kind === 'remove') {
      rows.push({ kind, text: line, oldLine, newLine: null })
      oldLine++
    } else {
      rows.push({ kind, text: line, oldLine, newLine })
      oldLine++
      newLine++
    }
  }
  return rows
}

export function diffStat(text: string): { add: number; remove: number } {
  let add = 0
  let remove = 0
  for (const row of parseUnifiedDiff(text)) {
    if (row.kind === 'add' && !row.text.startsWith('+++')) add++
    else if (row.kind === 'remove' && !row.text.startsWith('---')) remove++
  }
  return { add, remove }
}

const PATCH_HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export type PatchResult = { text: string; applied: boolean }

/**
 * 把统一 diff 应用到旧版本，得到新版本文本（staged / commit 差异的右侧内容）。
 * 上下文与删除行从原文取，新增行从 diff 取；原文与 hunk 行号对不上时标记 applied:false。
 */
export function applyUnifiedDiff(original: string, diff: string): PatchResult {
  const source = original.replace(/\r\n/g, '\n')
  const lines = source.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  if (!diff.trim()) return { text: source, applied: true }

  const out: string[] = []
  let cursor = 0
  let inHunk = false
  let applied = true
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    const header = PATCH_HUNK.exec(line)
    if (header) {
      inHunk = true
      const oldStart = Number(header[1]) || 0
      const target = Math.min(oldStart > 0 ? oldStart - 1 : 0, lines.length)
      if (target < cursor) applied = false
      for (; cursor < target; cursor++) out.push(lines[cursor] ?? '')
      continue
    }
    if (!inHunk) continue
    // 文件头、无换行标记、分隔空行都不占原文行号。
    if (line === '' || /^(?:diff |index |---|\+\+\+|\\ )/.test(line)) continue
    const marker = line[0] ?? ''
    if (marker === ' ') {
      if (cursor >= lines.length) applied = false
      out.push(lines[cursor] ?? '')
      cursor++
    } else if (marker === '-') {
      if (cursor >= lines.length) applied = false
      cursor++
    } else if (marker === '+') {
      out.push(line.slice(1))
    } else {
      inHunk = false
    }
  }
  for (; cursor < lines.length; cursor++) out.push(lines[cursor] ?? '')
  return { text: out.join('\n'), applied }
}
