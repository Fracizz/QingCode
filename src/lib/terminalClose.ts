import { safeInvoke } from './tauri'
import type { TerminalTab } from '../types'

/** True when the tab can be closed without two-click confirmation or a dialog. */
export async function canCloseTerminalDirectly(
  terminal: TerminalTab | undefined
): Promise<boolean> {
  if (!terminal) return false
  if (terminal.status === 'exited') return true
  if (terminal.shellKind) return false
  try {
    const hasChildren = await safeInvoke<boolean>(
      '查询终端子进程',
      'terminal_has_child_processes',
      { id: terminal.id }
    )
    return !hasChildren
  } catch {
    return false
  }
}
