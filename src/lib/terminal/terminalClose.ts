import { safeInvoke } from '@/lib/tauri'
import type { TerminalTab } from '@/types'
import { resolveTerminalBusy } from '@/lib/terminal/terminalBusy'
import { getTerminalCommandRunning } from '@/lib/terminal/terminalCommandActivity'

function isTerminalNotFoundError(error: unknown): boolean {
  const message = String(error).toLowerCase()
  // Only a missing PTY session. A broader "not found" also matches
  // "Command not found" and would skip the close prompt.
  return message.includes('terminal not found')
}

async function hasMeaningfulChildProcesses(terminalId: string): Promise<boolean> {
  try {
    return await safeInvoke<boolean>('查询终端子进程', 'terminal_has_child_processes', {
      id: terminalId,
    })
  } catch (error) {
    // Backend session already gone → nothing left to terminate.
    if (isTerminalNotFoundError(error)) return false
    // Fail closed for close confirmation (prefer asking once).
    return true
  }
}

/**
 * Tab X: a session that has not exited arms on the first click and closes on
 * the second. Exited tabs close immediately. This does not consult the child
 * process probe — a foreground TUI can be invisible to that probe.
 */
export function terminalCloseButtonAction(
  status: TerminalTab['status'] | undefined,
  armed: boolean,
): 'close' | 'arm' | 'ignore' {
  if (!status) return 'ignore'
  if (status === 'exited' || armed) return 'close'
  return 'arm'
}

/** True when bulk close / the context menu can skip the terminate dialog. */
export async function canCloseTerminalDirectly(
  terminal: TerminalTab | undefined,
): Promise<boolean> {
  if (!terminal) return false
  return !(await isTerminalBusy(terminal))
}

/** True when a foreground command / run task / meaningful child is active. */
export async function isTerminalBusy(terminal: TerminalTab): Promise<boolean> {
  if (terminal.status === 'exited') return false
  const hasMeaningfulChildren = await hasMeaningfulChildProcesses(terminal.id)
  return resolveTerminalBusy({
    status: terminal.status,
    shellKind: terminal.shellKind,
    commandRunning: getTerminalCommandRunning(terminal.id),
    hasMeaningfulChildren,
  })
}

/** Terminals that should warn on app/tab bulk close. Idle shells are excluded. */
export async function listBusyTerminals(terminals: TerminalTab[]): Promise<TerminalTab[]> {
  const busy: TerminalTab[] = []
  for (const terminal of terminals) {
    if (await isTerminalBusy(terminal)) busy.push(terminal)
  }
  return busy
}
