/**
 * 「清除输入」：清掉当前终端提示符或 AI CLI 输入框里尚未提交的内容。
 *
 * 终端拿不到输入行文本，只能模拟编辑键，不同程序认的键不同：
 * - POSIX Shell（readline / zle / fish）：Ctrl+E 移到行尾，再 Ctrl+U 删到行首。空输入时两者都是空操作。
 * - AI CLI（Claude Code / Codex 等，会开启 bracketed paste）的输入框可多行，Ctrl+U 只删当前行：
 *   按行数重复「Ctrl+E Ctrl+U 清当前行 → Backspace 并入上一行 → Delete 并入下一行」，
 *   逐行收拢直到清空；多余的轮次全是空操作。bash 5.1+ 提示符也开 bracketed paste，
 *   多出的 Backspace/Delete 在空行上同样无副作用（xterm 默认不响铃）。
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
/** 多行输入每轮：清当前行，Backspace（DEL）并入上一行，Delete（CSI 3~）并入下一行。 */
export const CLEAR_INPUT_MULTILINE_STEP = `${CLEAR_INPUT_EMACS}\x7f\x1b[3~`
/** 多行清除轮次上下限：至少覆盖常见输入框高度，上限避免一次写入过多按键。 */
const MULTILINE_MIN_ROUNDS = 24
const MULTILINE_MAX_ROUNDS = 200

export interface TerminalClearInputContext {
  /** 实际运行的 Shell（resolvedShell 优先）；未解析时为 auto / undefined。 */
  shell?: TerminalShellId
  /** 终端所在主机是否为 Windows（本机或 Windows SSH），仅在 Shell 未知时使用。 */
  windowsHost: boolean
  /** 前台程序是否开启了 bracketed paste（AI CLI 的信号）。 */
  bracketedPaste: boolean
  /** 终端可见行数，用来估计多行输入最多有几行（输入框不会比屏幕更高）。 */
  rows?: number
}

/** 生成清除多行输入的按键序列；末尾再清一次，收掉最后一轮并入的行。 */
export function multilineClearInputSequence(rows = 0): string {
  const rounds = Math.min(MULTILINE_MAX_ROUNDS, Math.max(MULTILINE_MIN_ROUNDS, Math.floor(rows)))
  return CLEAR_INPUT_MULTILINE_STEP.repeat(rounds) + CLEAR_INPUT_EMACS
}

export function terminalClearInputSequence(context: TerminalClearInputContext): string {
  if (context.bracketedPaste) return multilineClearInputSequence(context.rows)
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
