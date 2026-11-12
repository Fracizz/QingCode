import type { TerminalTab } from '@/types'

/** Detached daemon terminal returned by `ssh_list_detached_terminals`. */
export type SshDetachedTerminal = {
  /** Daemon PTY id, stable across app restarts. */
  ptyId: string
  /** SSH connection that owns the daemon. */
  connectionId: string
  /** SSH resource URI rooted at a registered workspace. */
  cwd: string
  /** Current remote PTY size. */
  cols: number
  rows: number
  /** Optional display name from the daemon. */
  name?: string
  /** 旧桌面端写在 daemon 名称字段里的原标签 ID，用于查回本地显示名。 */
  originalTabId?: string
  /** 无人接回时自动结束的时间（本机毫秒）；旧版 daemon 没有。 */
  expiresAt?: number
}

/** 本机 PTY 宿主托管的终端在标签上的连接标识，须与后端 `LOCAL_CONNECTION_ID` 一致。 */
export const LOCAL_TERMINAL_CONNECTION_ID = '__local__'

export type TerminalRestorePlan =
  | {
      mode: 'attach'
      ptyId: string
      connectionId: string
      cwd: string
      /**
       * 原 PTY 确认不存在时的处理。`stop` 保留现场，由用户决定是否新建；
       * `create` 只用于本地托管终端：宿主随电脑重启消失很常见，沿用本地终端按原配置重建的语义。
       */
      fallback: 'stop' | 'create'
    }
  | { mode: 'create' }

type RestorableTerminal = Pick<
  TerminalTab,
  'persistent' | 'ptyId' | 'connectionId' | 'cwd' | 'awaitingRestoreSpawn'
>

/**
 * Decide how to start a restored tab.
 * Attach is limited to the first start after app hydration so an explicit
 * restart never targets the PTY generation the user asked us to replace.
 */
export function planTerminalRestore(tab: RestorableTerminal): TerminalRestorePlan {
  if (
    tab.awaitingRestoreSpawn !== true ||
    tab.persistent !== true ||
    !tab.ptyId?.trim() ||
    !tab.connectionId?.trim() ||
    !tab.cwd.trim()
  ) {
    return { mode: 'create' }
  }
  return {
    mode: 'attach',
    ptyId: tab.ptyId.trim(),
    connectionId: tab.connectionId.trim(),
    cwd: tab.cwd,
    fallback: tab.connectionId.trim() === LOCAL_TERMINAL_CONNECTION_ID ? 'create' : 'stop',
  }
}

/** Match the spawn decision on every client/remote OS, never infer it from a path or shell. */
export function terminalRestoreNotices(tab: RestorableTerminal): {
  history: string
  starting: string | null
} {
  if (planTerminalRestore(tab).mode === 'attach') {
    return { history: '会话输出已恢复；正在接回原终端…', starting: null }
  }
  return {
    history: '会话输出已恢复；进程将按原配置重新启动',
    starting: '正在重启终端…',
  }
}

function isPositiveSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** Validate one IPC result before it reaches the terminal store. */
export function parseSshDetachedTerminal(value: unknown, now = Date.now()): SshDetachedTerminal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.ptyId !== 'string' || !record.ptyId.trim()) return null
  if (typeof record.connectionId !== 'string' || !record.connectionId.trim()) return null
  if (typeof record.cwd !== 'string' || !record.cwd.startsWith('ssh://')) return null
  if (!isPositiveSize(record.cols) || !isPositiveSize(record.rows)) return null
  return {
    ptyId: record.ptyId.trim(),
    connectionId: record.connectionId.trim(),
    cwd: record.cwd,
    cols: record.cols,
    rows: record.rows,
    ...(typeof record.name === 'string' && record.name.trim() ? { name: record.name.trim() } : {}),
    ...(typeof record.originalTabId === 'string' && record.originalTabId ? { originalTabId: record.originalTabId } : {}),
    // 远端只报剩余时长，用本机时钟换算，两台机器时间不一致也不影响。
    ...(typeof record.detachedRemainingMs === 'number' && record.detachedRemainingMs >= 0
      ? { expiresAt: now + record.detachedRemainingMs }
      : {}),
  }
}

/** 比较用的 SSH URI：去掉末尾斜杠；Windows 盘符路径不区分大小写。 */
function comparableSshUri(uri: string): string {
  const trimmed = uri.replace(/\/+$/, '')
  return /^ssh:\/\/[^/]+\/[A-Za-z]:(\/|$)/.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

/** `cwd` 是否位于 `root` 之内（含根本身）。 */
export function sshUriWithinRoot(cwd: string, root: string): boolean {
  const target = comparableSshUri(cwd)
  const base = comparableSshUri(root)
  return target === base || target.startsWith(`${base}/`)
}

/**
 * 只保留归属当前项目的孤儿终端：同一连接下有多个项目时，终端归给包含其
 * 工作目录的最深项目根，避免把项目 B 的终端接回或结束到项目 A。
 */
function belongsToProject(
  cwd: string,
  projectRoot: string,
  connectionRoots: readonly string[]
): boolean {
  if (!sshUriWithinRoot(cwd, projectRoot)) return false
  const depth = comparableSshUri(projectRoot).length
  return !connectionRoots.some(
    root => comparableSshUri(root).length > depth && sshUriWithinRoot(cwd, root)
  )
}

/** Keep only unattached daemon PTYs for this project, once per PTY id. */
export function filterUnownedDetachedTerminals(
  detached: readonly SshDetachedTerminal[],
  localTerminals: readonly Pick<TerminalTab, 'ptyId' | 'connectionId'>[],
  connectionId: string,
  projectRoot: string,
  connectionRoots: readonly string[] = []
): SshDetachedTerminal[] {
  const owned = new Set(
    localTerminals.flatMap(terminal => {
      if (terminal.connectionId && terminal.connectionId !== connectionId) return []
      return terminal.ptyId ? [terminal.ptyId] : []
    })
  )
  const seen = new Set<string>()
  return detached.filter(terminal => {
    if (terminal.connectionId !== connectionId) return false
    if (!belongsToProject(terminal.cwd, projectRoot, connectionRoots)) return false
    if (owned.has(terminal.ptyId) || seen.has(terminal.ptyId)) return false
    seen.add(terminal.ptyId)
    return true
  })
}
