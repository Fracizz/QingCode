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
