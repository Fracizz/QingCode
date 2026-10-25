import { isSshResource, safeInvoke } from '../tauri'
import {
  parseSshDetachedTerminal,
  type SshDetachedTerminal,
} from '../terminal/terminalRestorePlan'

const sshTerminalIds = new Set<string>()

/** 多个 xterm 视图可同时请求暂停同一终端；全部释放后才恢复读取。 */
const outputPauseHolders = new Map<string, Set<object>>()

/**
 * xterm 积压时暂停后端读取本地 PTY，让子进程在写满 PTY 后阻塞。
 * SSH 终端不暂停：russh 收到数据即扩大窗口，读取停住会堵塞整条 SSH 连接
 * （SFTP、Git、其他终端、保活），且回显与输出同流，后端缓存也不会更快。
 */
export function setTerminalOutputPaused(id: string, holder: object, paused: boolean) {
  const holders = outputPauseHolders.get(id) ?? new Set<object>()
  const wasPaused = holders.size > 0
  if (paused) holders.add(holder)
  else holders.delete(holder)
  if (holders.size > 0) outputPauseHolders.set(id, holders)
  else outputPauseHolders.delete(id)
  const isPaused = holders.size > 0
  if (wasPaused === isPaused || sshTerminalIds.has(id)) return
  void safeInvoke('终端输出流控', 'set_terminal_output_paused', { id, paused: isPaused }).catch(
    () => {
      // 终端已退出或不存在时忽略。
    }
  )
}

export type TerminalSpawnResult = {
  resolvedShell?: unknown
  fallbackFrom?: unknown
  /** Set by `ssh_create_terminal` / `ssh_attach_terminal`. */
  persistent?: boolean
  /** Daemon PTY id; required when `persistent` is true. */
  ptyId?: string
  /** SSH connection owning the daemon PTY. */
  connectionId?: string
}

export type TerminalAttachArgs = {
  /** Local QingCode terminal tab id. */
  id: string
  /** Daemon PTY id returned by create/list. */
  ptyId: string
  /** SSH resource URI under a registered workspace root. */
  cwd: string
  cols: number
  rows: number
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

/**
 * Attach a local terminal tab to an existing daemon PTY.
 * The backend returns the same spawn result shape as `ssh_create_terminal`.
 */
export function attachTerminal(args: TerminalAttachArgs): Promise<TerminalSpawnResult> {
  sshTerminalIds.add(args.id)
  return safeInvoke<TerminalSpawnResult>(
    '接回 SSH 终端',
    'ssh_attach_terminal',
    args,
  ).catch(error => {
    sshTerminalIds.delete(args.id)
    throw error
  })
}

/** List detached daemon PTYs owned by this QingCode installation. */
export async function listDetachedTerminals(
  connectionId: string,
): Promise<SshDetachedTerminal[]> {
  const result = await safeInvoke<unknown[]>(
    '查询远端终端',
    'ssh_list_detached_terminals',
    { connectionId },
  )
  return result
    .map(parseSshDetachedTerminal)
    .filter((terminal): terminal is SshDetachedTerminal => terminal != null)
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
  outputPauseHolders.delete(id)
  const remote = sshTerminalIds.delete(id)
  return safeInvoke('关闭终端', remote ? 'ssh_kill_terminal' : 'kill_terminal', { id })
}

export function terminalSessionOpen(id: string): Promise<boolean> {
  return safeInvoke<boolean>('查询终端会话', 'terminal_session_open', { id })
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
