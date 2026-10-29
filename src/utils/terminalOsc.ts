/** Normalize OSC window titles for tab labels (emoji prefix, mojibake, etc.). */
export function sanitizeOscTitle(title: string): string {
  let cleaned = title.trim()
  if (!cleaned) return cleaned

  cleaned = cleaned
    .replace(/^[\s\p{Extended_Pictographic}\p{So}\uFE0F\u200D]+/u, '')
    .trim()

  const mojibakePrefix = cleaned.match(
    /^[^\x20-\x7E\u4E00-\u9FFF]{1,12}\s+([\x20-\x7E\u4E00-\u9FFF].*)$/
  )
  if (mojibakePrefix?.[1]) return mojibakePrefix[1].trim()

  return cleaned
}

export type TerminalOscHandlers = {
  onTitle?: (title: string) => void
  /** Foreground command started (FinalTerm / VS Code shell integration). */
  onCommandStart?: () => void
  /** Foreground command finished or prompt returned. */
  onCommandEnd?: () => void
  /** Text written by a terminal application; clipboard reads are never exposed. */
  onClipboardWrite?: (text: string) => void
}

/**
 * Parse shell-integration markers.
 * - `133;C` / `633;C` → command executed
 * - `133;D` / `633;D` → command finished
 * - `133;A` / `633;A` → prompt start (treat as idle)
 */
export function parseShellIntegrationOsc(
  body: string,
): 'start' | 'end' | null {
  // body is everything after `OSC ` / `]` — e.g. `133;C` or `633;D;0`
  const match = /^(?:133|633);([A-Za-z])/.exec(body)
  if (!match) return null
  const code = match[1].toUpperCase()
  if (code === 'C') return 'start'
  if (code === 'D' || code === 'A') return 'end'
  return null
}

/** xterm `term.parser` 中注册 OSC 处理所需的最小接口，便于单测。 */
export type TerminalOscRegistry = {
  registerOscHandler(ident: number, callback: (data: string) => boolean): { dispose(): void }
}

const TITLE_OSC_IDENTS = [0, 1, 2] as const
const SHELL_INTEGRATION_OSC_IDENTS = [133, 633] as const
/**
 * xterm 或已加载插件默认会响应、但我们需要吞掉的 OSC：
 * 8 超链接（默认弹原生 confirm 并 window.open）、
 * 4/10/11/12/104/110/111/112 调色板与颜色查询。其余编号 xterm 本身就会忽略。
 */
export const SUPPRESSED_OSC_IDENTS = [4, 8, 10, 11, 12, 104, 110, 111, 112] as const

/** Bound application clipboard writes to 1 MiB of UTF-8 text. */
export const MAX_OSC_CLIPBOARD_BYTES = 1024 * 1024

function clipboardWriteText(data: string): string | undefined {
  const separator = data.indexOf(';')
  if (separator < 0 || !/^[cs]*$/.test(data.slice(0, separator))) return
  const encoded = data.slice(separator + 1)
  // Reject queries, unsupported selections and malformed payloads without clearing the clipboard.
  if (encoded.length > Math.ceil(MAX_OSC_CLIPBOARD_BYTES / 3) * 4) return
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return
  try {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
    if (bytes.length > MAX_OSC_CLIPBOARD_BYTES) return
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return
  }
}

/**
 * 在 xterm 解析器上直接处理窗口标题与 shell-integration 标记，并吞掉这些序列。
 * 相比在输出流里先解码再重编码扫描，零额外拷贝，且天然处理跨分块的序列。
 * OSC 52 始终在此终结：只转发有效文本写入，禁止插件读取本机剪贴板。
 */
export function registerTerminalOscHandlers(
  parser: TerminalOscRegistry,
  handlers: TerminalOscHandlers,
): () => void {
  const disposables = [
    ...SUPPRESSED_OSC_IDENTS.map(ident => parser.registerOscHandler(ident, () => true)),
    parser.registerOscHandler(52, data => {
      const text = clipboardWriteText(data)
      if (text !== undefined) handlers.onClipboardWrite?.(text)
      return true
    }),
    ...TITLE_OSC_IDENTS.map(ident =>
      parser.registerOscHandler(ident, data => {
        const title = data.trim()
        if (title) handlers.onTitle?.(sanitizeOscTitle(title))
        return true
      }),
    ),
    ...SHELL_INTEGRATION_OSC_IDENTS.map(ident =>
      parser.registerOscHandler(ident, data => {
        const marker = parseShellIntegrationOsc(`${ident};${data}`)
        if (marker === 'start') handlers.onCommandStart?.()
        else if (marker === 'end') handlers.onCommandEnd?.()
        return true
      }),
    ),
  ]
  return () => disposables.forEach(disposable => disposable.dispose())
}
