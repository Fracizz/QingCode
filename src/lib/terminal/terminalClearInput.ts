/**
 * 「清除输入」：清掉当前终端提示符或 AI CLI 输入框里尚未提交的内容。
 *
 * 终端拿不到输入行文本，只能模拟编辑键，不同程序认的键不同：
 * - AI CLI（Claude Code / Codex 等，会开启 bracketed paste）和 POSIX Shell（readline / zle / fish）：
 *   Ctrl+E 移到行尾，再 Ctrl+U 删到行首。空输入时两者都是空操作。
 * - Windows PowerShell / pwsh（PSReadLine Windows 模式）和 cmd.exe：Esc 清空整行。
 *
 * 不用 Ctrl+C：Shell 里会中断前台命令，AI CLI 空输入时会提示退出。
 * AI CLI 里也不用 Esc：Claude Code 会把 Esc 当作中断当前任务。
 */
import type { TerminalShellId } from './terminalShell'

/** Ctrl+E（行尾）+ Ctrl+U（删到行首）。 */
export const CLEAR_INPUT_EMACS = '\x05\x15'
/** Esc：PSReadLine RevertLine / cmd.exe 清空当前行。 */
export const CLEAR_INPUT_WINDOWS = '\x1b'

export interface TerminalClearInputContext {
  /** 实际运行的 Shell（resolvedShell 优先）；未解析时为 auto / undefined。 */
  shell?: TerminalShellId
  /** 终端所在主机是否为 Windows（本机或 Windows SSH），仅在 Shell 未知时使用。 */
  windowsHost: boolean
  /** 前台程序是否开启了 bracketed paste（AI CLI 的信号）。 */
  bracketedPaste: boolean
}

export function terminalClearInputSequence(context: TerminalClearInputContext): string {
  if (context.bracketedPaste) return CLEAR_INPUT_EMACS
  switch (context.shell) {
    case 'powershell':
    case 'pwsh':
    case 'cmd':
      return CLEAR_INPUT_WINDOWS
    case 'wsl':
    case 'bash':
    case 'zsh':
      return CLEAR_INPUT_EMACS
    default:
      return context.windowsHost ? CLEAR_INPUT_WINDOWS : CLEAR_INPUT_EMACS
  }
}
