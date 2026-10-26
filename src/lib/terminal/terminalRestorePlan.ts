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
}

export type TerminalRestorePlan =
  | {
      mode: 'attach'
      ptyId: string
      connectionId: string
      cwd: string
      /** A failed attach is followed by the ordinary spawn path. */
      fallback: 'create'
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
    fallback: 'create',
  }
}

function isPositiveSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** Validate one IPC result before it reaches the terminal store. */
export function parseSshDetachedTerminal(value: unknown): SshDetachedTerminal | null {
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
