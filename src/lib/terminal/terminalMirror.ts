/**
 * 手机接入电脑终端时的初始画面。终端输出由 Rust 直接分发给手机（见 src-tauri/src/mobile/hub.rs
 * 的 `tap_output`），这里只在 Rust 侧镜像不完整（开启接入前已有输出）时提供一次电脑当前画面。
 */

export interface TerminalCapture {
  data: string
  cols: number
  rows: number
}

const captures = new Map<string, () => Promise<TerminalCapture>>()

export function registerTerminalCapture(id: string, capture: () => Promise<TerminalCapture>) {
  captures.set(id, capture)
  return () => {
    if (captures.get(id) === capture) captures.delete(id)
  }
}

export function terminalCapture(id: string) {
  return captures.get(id)
}

/**
 * 持久化用的已渲染画面：xterm 序列化结果（按 `cols`×`rows` 排版）加上已收到、尚未解析的原始输出。
 * 行内 TUI（Claude Code 等）按差量重画，截断过的原始字节回放后会叠出残帧；持久化渲染好的画面，
 * 重启接回时才能和程序以为的屏幕一致。视图还在回放历史或写入快照时返回 null，由调用方改存原始输出。
 */
export interface TerminalPersistCapture {
  data: string
  cols: number
  rows: number
  /** `data` 开头属于序列化画面的字符数，其后是未解析的原始输出。 */
  screenChars: number
}

/** `scrollback` 是设置里的行数上限，`maxChars` 是这一终端的持久化字符预算（据此少序列化些行）。 */
export type TerminalPersistCaptureFn = (limits: {
  scrollback: number
  maxChars: number
}) => TerminalPersistCapture | null

const persistCaptures = new Map<string, TerminalPersistCaptureFn>()

export function registerTerminalPersistCapture(id: string, capture: TerminalPersistCaptureFn) {
  persistCaptures.set(id, capture)
  return () => {
    if (persistCaptures.get(id) === capture) persistCaptures.delete(id)
  }
}

export function terminalPersistCapture(id: string) {
  return persistCaptures.get(id)
}
