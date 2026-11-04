import type { Terminal } from '@xterm/xterm'

/** Read displayed cells, never the PTY stream (which contains TUI repaint commands). */
export function terminalContent(
  term: Pick<Terminal, 'buffer' | 'rows' | 'cols'>,
  scope: 'screen' | 'buffer'
): string {
  const buffer = term.buffer.active
  const start = scope === 'screen' ? buffer.viewportY : 0
  const end = scope === 'screen' ? Math.min(start + term.rows, buffer.length) : buffer.length
  const lines: string[] = []
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    const continues = y + 1 < end && buffer.getLine(y + 1)?.isWrapped
    let columnEnd = term.cols
    if (continues) {
      // A wide CJK/emoji cell can wrap early, leaving an unwritten padding cell.
      // Preserve typed spaces while excluding that padding from logical text.
      while (columnEnd > 0) {
        const cell = line.getCell(columnEnd - 1)
        if (!cell || cell.getChars() || cell.getWidth() === 0) break
        columnEnd--
      }
    }
    const text = line.translateToString(!continues, 0, columnEnd)
    if (y > start && line.isWrapped && lines.length) {
      lines[lines.length - 1] += text
    } else lines.push(text)
  }
  while (lines.at(-1) === '') lines.pop()
  return lines.join('\n')
}

export function terminalExportName(name: string, now = new Date()): string {
  const label =
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/, '')
      .slice(0, 70) || 'terminal'
  return `${label}-${now.toISOString().replace(/[:.]/g, '-')}.txt`
}
