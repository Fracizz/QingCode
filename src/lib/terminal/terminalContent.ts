import type { Terminal } from '@xterm/xterm'

export type TerminalContentScope = 'screen' | 'buffer'

type TerminalReader = (scope: TerminalContentScope) => Promise<string>

const readers = new Map<string, TerminalReader>()

/** xterm 实例常驻，切换项目后仍可读取；CLI 按终端 ID 取用。 */
export function registerTerminalReader(id: string, reader: TerminalReader) {
  readers.set(id, reader)
  return () => {
    if (readers.get(id) === reader) readers.delete(id)
  }
}

export function terminalReader(id: string) {
  return readers.get(id)
}

/**
 * 从原始 PTY 输出近似还原文本：去掉控制序列，`\r` 覆盖的行只留最后一段。
 * 不解析光标移动，TUI 重绘的内容不准确，仅用于没有 xterm 实例的终端。
 */
export function plainTerminalText(raw: string): string {
  const lines = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[@-Z\\^_=>]/g, '')
    .split(/\r?\n/)
    .map(line => line.split('\r').filter(Boolean).at(-1) ?? '')
  while (lines.at(-1) === '') lines.pop()
  return lines.join('\n')
}

/** Read displayed cells, never the PTY stream (which contains TUI repaint commands). */
export function terminalContent(
  term: Pick<Terminal, 'buffer' | 'rows' | 'cols'>,
  scope: TerminalContentScope
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
