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
