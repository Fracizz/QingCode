import { initialAnsiState, parseAnsi, type AnsiSegment, type AnsiState } from './ansi'

// 每个 run 的输出：按行保存带样式片段，最多保留 MAX_LINES 行；纯数据，每次追加返回新对象供 React 比较。

export const MAX_LINES = 5000

export type OutputSegment = AnsiSegment & { err?: boolean }

export type OutputLine = { id: number; segments: OutputSegment[] }

export type RunOutput = {
  lines: OutputLine[]
  /** 尚未换行的当前行 */
  current: OutputSegment[]
  ansi: AnsiState
  /** 上一块以 \r 结尾：下一块若以 \n 开头则视为 \r\n */
  pendingCR: boolean
  nextId: number
  /** 因超出行数上限或 server 缓冲截断而丢弃过输出 */
  dropped: boolean
  /** 已应用的最大 seq */
  lastSeq: number
}

export function emptyOutput(): RunOutput {
  return { lines: [], current: [], ansi: initialAnsiState(), pendingCR: false, nextId: 1, dropped: false, lastSeq: 0 }
}

export function appendOutput(output: RunOutput, data: string, stream: 'stdout' | 'stderr', seq?: number): RunOutput {
  const parsed = parseAnsi(data, output.ansi)
  const newLines: OutputLine[] = []
  let current = output.current.slice()
  let nextId = output.nextId
  let pendingCR = output.pendingCR
  const err = stream === 'stderr'

  const addText = (text: string, style: AnsiSegment['style']): void => {
    if (!text) return
    const last = current[current.length - 1]
    if (last && last.style === style && Boolean(last.err) === err) {
      current[current.length - 1] = { ...last, text: last.text + text }
    } else {
      current.push(err ? { text, style, err } : { text, style })
    }
  }

  for (const segment of parsed.segments) {
    let start = 0
    const text = segment.text
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch !== '\n' && ch !== '\r') {
        if (pendingCR) {
          // 单独的 \r：进度条式覆盖，清掉当前行重新写。
          current = []
          pendingCR = false
        }
        continue
      }
      addText(text.slice(start, i), segment.style)
      start = i + 1
      if (ch === '\n') {
        newLines.push({ id: nextId++, segments: current })
        current = []
        pendingCR = false
      } else {
        pendingCR = true
      }
    }
    addText(text.slice(start), segment.style)
  }

  let lines = newLines.length > 0 ? output.lines.concat(newLines) : output.lines
  let dropped = output.dropped
  if (lines.length > MAX_LINES) {
    lines = lines.slice(lines.length - MAX_LINES)
    dropped = true
  }
  return {
    lines,
    current,
    ansi: parsed.state,
    pendingCR,
    nextId,
    dropped,
    lastSeq: seq !== undefined ? Math.max(output.lastSeq, seq) : output.lastSeq,
  }
}

/** 清空显示但保留 seq 与 ANSI 状态，后续输出接着追加。 */
export function clearOutput(output: RunOutput): RunOutput {
  return { ...output, lines: [], current: [], dropped: false }
}

export function markDropped(output: RunOutput): RunOutput {
  return output.dropped ? output : { ...output, dropped: true }
}

export function outputText(output: RunOutput): string {
  const line = (segments: OutputSegment[]): string => segments.map((s) => s.text).join('')
  const all = output.lines.map((l) => line(l.segments))
  if (output.current.length > 0) all.push(line(output.current))
  return all.join('\n')
}
