import { safeInvoke } from '../tauri'

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
  return safeInvoke(
    args.shellKind === 'interactive' ? '启动终端配置' : '启动任务',
    'spawn_script',
    args
  )
}

export function killTerminal(id: string): Promise<void> {
  return safeInvoke('关闭终端', 'kill_terminal', { id })
}

export function writeTerminal(id: string, data: string): Promise<void> {
  return safeInvoke('终端输入', 'write_terminal', { id, data })
}

export function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return safeInvoke('终端尺寸', 'resize_terminal', { id, cols, rows })
}
