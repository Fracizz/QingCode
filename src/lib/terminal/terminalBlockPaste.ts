/**
 * 多行文本（长文本面板「填入终端」、右键「添加到对话」）必须作为一次粘贴送进程序，
 * 否则换行会被当成回车逐行执行。
 *
 * - xterm 记录到程序开启了 bracketed paste：交给 `term.paste`，由 xterm 包裹粘贴标记。
 * - xterm 的模式标记丢失（回放的输出被截断、丢了程序启动时的 `ESC[?2004h` 等），但前台明确是
 *   Claude Code / Codex 等 AI CLI：这些程序在输入框里始终开启 bracketed paste，自行包裹标记后写入。
 * - 其余情况（普通 Shell 等）拒绝，调用方提示用户复制后手动粘贴。
 */
export type TerminalBlockPasteRoute = 'xterm' | 'wrapped' | null

export function terminalBlockPasteRoute(
  bracketedPasteMode: boolean,
  agentForeground: boolean
): TerminalBlockPasteRoute {
  if (bracketedPasteMode) return 'xterm'
  return agentForeground ? 'wrapped' : null
}

/** 与 xterm 的 paste 一致：换行统一为 CR 后包上粘贴标记；去掉 ESC，避免正文里的 `ESC[201~` 提前结束粘贴。 */
export function bracketedPasteInput(text: string): string {
  const body = text.replace(/\x1b/g, '').replace(/\r?\n/g, '\r')
  return `\x1b[200~${body}\x1b[201~`
}
