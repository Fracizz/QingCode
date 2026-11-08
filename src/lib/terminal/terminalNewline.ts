import { isSpinnerGlyph } from './terminalProgramActivity'

export const TERMINAL_NEWLINE_INPUT = '\n'

type TerminalNewlineKeyEvent = {
  type: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Ctrl/Cmd+Enter sends LF (Ctrl+J) without the CR used to submit a line. */
export function isTerminalNewlineShortcut(event: TerminalNewlineKeyEvent): boolean {
  return (
    event.type === 'keydown' &&
    event.key === 'Enter' &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey
  )
}

export function isTerminalShiftNewlineShortcut(event: TerminalNewlineKeyEvent): boolean {
  return (
    event.type === 'keydown' &&
    event.key === 'Enter' &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  )
}

export interface TerminalForegroundSignals {
  alternateBuffer: boolean
  mouseTracking: boolean
  focusReporting: boolean
  /** 程序设置的原始窗口标题。 */
  title: string
  /** shell 集成上报的前台状态；未上报时为 null。 */
  commandRunning: boolean | null
}

const AGENT_TITLE_RE = /\b(?:claude|codex|opencode)\b/i

/**
 * 前台是否为 Agent / TUI。普通 Shell 中 Shift+Enter 必须保持原样（发送 CR），
 * 这里宁可漏判也不把 LF 发给 Shell。
 *
 * 终端模式是程序主动开启的强信号，退出时会还原，优先采用，且不看 shell 集成：
 * 只上报提示符、不上报命令开始的集成，在 Agent 运行时仍会显示「停在提示符」。
 * 标题可能在程序退出后残留，因此 shell 集成明确报告回到提示符时不再相信标题。
 */
export function isTerminalAgentForeground(signals: TerminalForegroundSignals): boolean {
  if (signals.alternateBuffer || signals.mouseTracking || signals.focusReporting) return true
  if (signals.commandRunning === false) return false
  const title = signals.title.trim()
  const first = [...title][0]
  return isSpinnerGlyph(first) || first === '✳' || AGENT_TITLE_RE.test(title)
}
