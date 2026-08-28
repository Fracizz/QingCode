import { isSshResource, safeInvoke } from '../tauri'

const sshTerminalIds = new Set<string>()

export type TerminalSpawnResult = {
  resolvedShell?: unknown
  fallbackFrom?: unknown
}

export function createTerminal(args: {
  id: string
  cwd: string
  cols: number
  rows: number
  shell?: string | null
}): Promise<TerminalSpawnResult> {
  if (isSshResource(args.cwd)) {
    sshTerminalIds.add(args.id)
    return safeInvoke<TerminalSpawnResult>('新建 SSH 终端', 'ssh_create_terminal', args).catch(
      error => {
        sshTerminalIds.delete(args.id)
        throw error
      }
    )
  }
  sshTerminalIds.delete(args.id)
  return safeInvoke('新建终端', 'create_terminal', args)
}

export function spawnTerminalScript(args: {
  id: string
  cwd: string
  shellKind: string
  target: string
  env: Record<string, string>
  cols: number
  rows: number
  shell?: string | null
}): Promise<TerminalSpawnResult> {
  if (isSshResource(args.cwd)) {
    sshTerminalIds.add(args.id)
    return safeInvoke<TerminalSpawnResult>('启动 SSH 任务', 'ssh_spawn_script', args).catch(
      error => {
        sshTerminalIds.delete(args.id)
        throw error
      }
    )
  }
  return safeInvoke(
    args.shellKind === 'interactive' ? '启动终端配置' : '启动任务',
    'spawn_script',
    args
  )
}

export function killTerminal(id: string): Promise<void> {
  const remote = sshTerminalIds.delete(id)
  return safeInvoke('关闭终端', remote ? 'ssh_kill_terminal' : 'kill_terminal', { id })
}

export function writeTerminal(id: string, data: string): Promise<void> {
  return safeInvoke('终端输入', sshTerminalIds.has(id) ? 'ssh_write_terminal' : 'write_terminal', {
    id,
    data,
  })
}

export function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return safeInvoke(
    '终端尺寸',
    sshTerminalIds.has(id) ? 'ssh_resize_terminal' : 'resize_terminal',
    { id, cols, rows }
  )
}
