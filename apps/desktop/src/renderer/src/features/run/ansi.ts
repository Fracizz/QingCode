// 最小 ANSI 解析：只认 SGR 颜色 / 粗体 / 暗淡 / 斜体 / 下划线 / 反显 / 重置，其余转义序列去掉。
// 输出按块到达，转义序列可能被切断，未完成的部分留在 state.pending 等下一块。

export type AnsiStyle = {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

export type AnsiSegment = { text: string; style: AnsiStyle }

export type AnsiState = { style: AnsiStyle; pending: string }

export const initialAnsiState = (): AnsiState => ({ style: {}, pending: '' })

// 与深色主题协调的 16 色（参考 VS Code 终端默认配色）。
const BASIC = [
  '#5c5c5c', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5',
]
const BRIGHT = [
  '#808080', '#ff6b63', '#6fcf8f', '#ffe36b', '#5fa8ff', '#e48ee4', '#5fd7f0', '#ffffff',
]

export function color256(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined
  if (index < 8) return BASIC[index]
  if (index < 16) return BRIGHT[index - 8]
  if (index < 232) {
    const n = index - 16
    const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40)
    return rgb(level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6))
  }
  const gray = 8 + (index - 232) * 10
  return rgb(gray, gray, gray)
}

function rgb(r: number, g: number, b: number): string {
  const hex = (v: number): string => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/** 应用一条 SGR 参数列表，返回新样式（不修改入参）。 */
export function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
  const next: AnsiStyle = { ...style }
  const list = params.length === 0 ? [0] : params
  for (let i = 0; i < list.length; i++) {
    const code = list[i]!
    if (code === 0) {
      for (const key of Object.keys(next) as Array<keyof AnsiStyle>) delete next[key]
    } else if (code === 1) next.bold = true
    else if (code === 2) next.dim = true
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 7) next.inverse = true
    else if (code === 22) {
      delete next.bold
      delete next.dim
    } else if (code === 23) delete next.italic
    else if (code === 24) delete next.underline
    else if (code === 27) delete next.inverse
    else if (code >= 30 && code <= 37) next.fg = BASIC[code - 30]!
    else if (code >= 90 && code <= 97) next.fg = BRIGHT[code - 90]!
    else if (code === 39) delete next.fg
    else if (code >= 40 && code <= 47) next.bg = BASIC[code - 40]!
    else if (code >= 100 && code <= 107) next.bg = BRIGHT[code - 100]!
    else if (code === 49) delete next.bg
    else if (code === 38 || code === 48) {
      const mode = list[i + 1]
      let value: string | undefined
      if (mode === 5) {
        value = color256(list[i + 2] ?? -1)
        i += 2
      } else if (mode === 2) {
        value = rgb(list[i + 2] ?? 0, list[i + 3] ?? 0, list[i + 4] ?? 0)
        i += 4
      }
      if (value) {
        if (code === 38) next.fg = value
        else next.bg = value
      }
    }
  }
  return next
}

const ESC = '\u001b'

/** 解析一块文本；返回带样式的片段（不含转义序列）与新状态。 */
export function parseAnsi(input: string, state: AnsiState): { segments: AnsiSegment[]; state: AnsiState } {
  const text = state.pending + input
  const segments: AnsiSegment[] = []
  let style = state.style
  let buffer = ''
  const push = (): void => {
    if (!buffer) return
    const last = segments[segments.length - 1]
    if (last && last.style === style) last.text += buffer
    else segments.push({ text: buffer, style })
    buffer = ''
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === ESC) {
      if (i + 1 >= text.length) return finish(text.slice(i))
      const kind = text[i + 1]!
      if (kind === '[') {
        // CSI：参数字节 0x30–0x3F，中间字节 0x20–0x2F，结束字节 0x40–0x7E。
        let j = i + 2
        while (j < text.length && /[0-?]/.test(text[j]!)) j++
        while (j < text.length && /[ -/]/.test(text[j]!)) j++
        if (j >= text.length) return finish(text.slice(i))
        const final = text[j]!
        if (final === 'm') {
          const raw = text.slice(i + 2, j)
          if (!/[<=>?]/.test(raw)) {
            push()
            style = applySgr(style, raw.split(/[;:]/).filter((p) => p !== '').map((p) => Number(p)))
          }
        }
        i = j + 1
        continue
      }
      if (kind === ']' || kind === 'P' || kind === '_' || kind === '^') {
        // OSC / DCS 等字符串序列：到 BEL 或 ESC \ 为止。太长仍未结束就当作已损坏直接丢弃。
        let j = i + 2
        let end = -1
        while (j < text.length) {
          if (text[j] === '\u0007') {
            end = j + 1
            break
          }
          if (text[j] === ESC && text[j + 1] === '\\') {
            end = j + 2
            break
          }
          j++
        }
        if (end < 0) {
          if (text.length - i < 4096) return finish(text.slice(i))
          i = text.length
          continue
        }
        i = end
        continue
      }
      // 其余两字符序列（ESC c、ESC = 等）以及 ESC ( B 这类字符集切换。
      i += kind === '(' || kind === ')' ? 3 : 2
      continue
    }
    const code = ch.charCodeAt(0)
    if (code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t') {
      i++
      continue
    }
    if (code === 0x7f) {
      i++
      continue
    }
    buffer += ch
    i++
  }
  return finish('')

  function finish(pending: string): { segments: AnsiSegment[]; state: AnsiState } {
    push()
    return { segments, state: { style, pending } }
  }
}

/** 转成 React style 对象（不依赖 React 类型，便于单测）。 */
export function styleToCss(style: AnsiStyle): Record<string, string> {
  const css: Record<string, string> = {}
  let fg = style.fg
  let bg = style.bg
  if (style.inverse) {
    fg = style.bg ?? 'var(--color-qn-panel)'
    bg = style.fg ?? 'var(--color-qn-text)'
  }
  if (fg) css.color = fg
  if (bg) css.backgroundColor = bg
  if (style.bold) css.fontWeight = '600'
  if (style.dim) css.opacity = '0.65'
  if (style.italic) css.fontStyle = 'italic'
  if (style.underline) css.textDecoration = 'underline'
  return css
}

export function stripAnsi(text: string): string {
  return parseAnsi(text, initialAnsiState()).segments.map((s) => s.text).join('')
}
