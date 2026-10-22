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
 * 8 超链接（默认弹原生 confirm 并 window.open）、52 剪贴板（`?` 会把本机剪贴板回写给远端程序）、
 * 4/10/11/12/104/110/111/112 调色板与颜色查询。其余编号 xterm 本身就会忽略。
 */
export const SUPPRESSED_OSC_IDENTS = [4, 8, 10, 11, 12, 52, 104, 110, 111, 112] as const

/**
 * 在 xterm 解析器上直接处理窗口标题与 shell-integration 标记，并吞掉这些序列。
 * 相比在输出流里先解码再重编码扫描，零额外拷贝，且天然处理跨分块的序列。
 * 必须在加载 ClipboardAddon 之后注册：后注册的处理器先执行。
 */
export function registerTerminalOscHandlers(
  parser: TerminalOscRegistry,
  handlers: TerminalOscHandlers,
): () => void {
  const disposables = [
    ...SUPPRESSED_OSC_IDENTS.map(ident => parser.registerOscHandler(ident, () => true)),
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
