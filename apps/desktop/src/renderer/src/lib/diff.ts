export type DiffLineKind = 'add' | 'remove' | 'meta' | 'context'

export function tailLines(text: string, maxLines = 200): string {
  const limit = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 200
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-limit).join('\n')
}

export function lineCount(text: string): number {
  if (!text) return 0
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) {
    return 'meta'
  }
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  return 'context'
}

export function diffRows(text: string, maxLines = 200): Array<{ text: string; kind: DiffLineKind }> {
  const tail = tailLines(text, maxLines)
  if (!tail) return []
  return tail.split('\n').map((line) => ({ text: line, kind: classifyDiffLine(line) }))
}

export function isAtBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 48,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}
