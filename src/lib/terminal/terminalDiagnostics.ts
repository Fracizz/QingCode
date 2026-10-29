import type { TerminalTab } from '@/types'
import { isSshResource, isTauri, safeInvoke } from '../tauri'
import { save } from '@tauri-apps/plugin-dialog'
import { authorizePaths } from '../pathAllowlist'
import { translate } from '../i18n'

export type TerminalActionSource = 'user_close' | 'user_restart' | 'user_close_others'
  | 'user_close_all' | 'cancel_reconnect' | 'spawn_cancelled' | 'backend_cleanup'

export function recordTerminalDiagnostic(
  event: string,
  terminal: Pick<TerminalTab, 'id' | 'ptyId' | 'connectionId' | 'exitCode'>,
  source?: TerminalActionSource,
  operationId?: string,
): void {
  if (!isTauri()) return
  void safeInvoke('记录终端诊断', 'terminal_diagnostic_event', { event: {
    event, terminalId: terminal.id, ptyId: terminal.ptyId, connectionId: terminal.connectionId,
    exitCode: terminal.exitCode, source, operationId,
  } }).catch(error => console.warn('terminal diagnostic unavailable', error))
}

/** Metadata only: do not include terminal output, command history, or profile env. */
export async function collectTerminalDiagnostics(terminal: TerminalTab, rootUri?: string): Promise<string> {
  recordTerminalDiagnostic('terminal.export_requested', terminal)
  const sections = [JSON.stringify({
    exportedAt: new Date().toISOString(), terminalId: terminal.id, ptyId: terminal.ptyId,
    connectionId: terminal.connectionId, status: terminal.status, exitCode: terminal.exitCode,
    formatVersion: 1,
  })]
  const results = await Promise.allSettled([
    safeInvoke<string>('读取本机终端诊断', 'terminal_diagnostic_log'),
    isSshResource(terminal.cwd)
      ? safeInvoke<string>('读取远端终端诊断', 'ssh_terminal_diagnostic_log', { rootUri: rootUri ?? terminal.cwd })
      : Promise.resolve(''),
  ])
  for (const [index, result] of results.entries()) {
    const label = index === 0 ? 'local' : 'remote'
    sections.push(JSON.stringify({ section: label, available: result.status === 'fulfilled' }))
    // Error objects can include command arguments. Keep the failure explicit without serializing them.
    if (result.status === 'fulfilled') sections.push(result.value)
  }
  return sections.join('\n')
}

export async function exportTerminalDiagnostics(terminal: TerminalTab, rootUri?: string): Promise<boolean> {
  const defaultPath = `terminal-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  // Ask for the destination before connecting to the remote host.
  const path = isTauri() ? await save({
    title: translate('导出终端诊断'), defaultPath,
    filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }],
  }) : defaultPath
  if (!path) return false
  const content = await collectTerminalDiagnostics(terminal, rootUri)
  if (isTauri()) {
    await authorizePaths([path])
    await safeInvoke('导出终端诊断', 'write_file', { path, content, encoding: 'utf-8' })
  } else {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/x-ndjson;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = path
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return true
}
