import type { TerminalTab } from '@/types'

export type TerminalConnectionRestore = 'replay' | 'snapshot' | 'none'

export type TerminalNotice = {
  key: string
  values?: Record<string, string | number>
}

export type TerminalConnectionPlan = {
  status: 'reconnecting' | 'running'
  notice: TerminalNotice | null
  reason: string | null
  attempt: number | null
  restore: TerminalConnectionRestore | null
}

export type TerminalExitEvent = {
  id: string
  exitCode: number
  disconnected: boolean
  reason: string | null
}

/** 只接受后端提供的非空字符串原因；其他类型一律忽略。 */
export function normalizeTerminalDisconnectReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const reason = value.trim()
  return reason ? reason : null
}

/**
 * Tauri's current terminal payload uses snake_case, while newer command
 * results use camelCase. Accept both without weakening reason validation.
 */
export function parseTerminalExitEvent(payload: unknown): TerminalExitEvent | null {
  if (!payload || typeof payload !== 'object') return null
  const event = payload as Record<string, unknown>
  if (typeof event.id !== 'string' || !event.id) return null
  const rawExitCode = event.exitCode ?? event.exit_code
  if (typeof rawExitCode !== 'number' || !Number.isFinite(rawExitCode)) return null
  return {
    id: event.id,
    exitCode: rawExitCode,
    disconnected: event.disconnected === true,
    reason: normalizeTerminalDisconnectReason(event.reason),
  }
}

function parseAttempt(value: unknown): number | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined
  return value
}

function parseRestore(value: unknown): TerminalConnectionRestore | null | undefined {
  if (value === undefined) return null
  return value === 'replay' || value === 'snapshot' || value === 'none' ? value : undefined
}

/**
 * Translate a persistent terminal connection event into tab state and at most
 * one notice per disconnect cycle. Repeated reconnect attempts stay quiet.
 */
export function planTerminalConnectionEvent(
  tab: Pick<TerminalTab, 'status'>,
  payload: unknown,
): TerminalConnectionPlan | null {
  if (!payload || typeof payload !== 'object') return null
  const event = payload as Record<string, unknown>
  if (typeof event.id !== 'string' || !event.id) return null
  if (event.state !== 'reconnecting' && event.state !== 'attached') return null
  if (tab.status === 'exited') return null

  const reason = event.reason === undefined ? null : normalizeTerminalDisconnectReason(event.reason)
  if (event.reason !== undefined && reason === null) return null
  const attempt = parseAttempt(event.attempt)
  if (attempt === undefined) return null
  const restore = parseRestore(event.restore)
  if (restore === undefined) return null

  if (event.state === 'reconnecting') {
    const firstAttempt = tab.status !== 'reconnecting'
    return {
      status: 'reconnecting',
      notice: firstAttempt
        ? reason
          ? {
              key: 'SSH 连接已断开（{reason}），正在重新连接，远端进程仍在运行…',
              values: { reason },
            }
          : { key: 'SSH 连接已断开，正在重新连接，远端进程仍在运行…' }
        : null,
      reason,
      attempt,
      restore,
    }
  }

  return {
    status: 'running',
    notice:
      restore === 'snapshot'
        ? { key: '已重新连接（已从屏幕快照恢复，部分历史输出不可用）' }
        : { key: '已重新连接' },
    reason,
    attempt,
    restore,
  }
}

/** SSH 直连终端的断线提示；有后端原因时附在提示中。 */
export function terminalDisconnectNotice(
  kind: 'reconnecting' | 'stopped',
  rawReason: unknown,
): TerminalNotice {
  const reason = normalizeTerminalDisconnectReason(rawReason)
  if (reason) {
    return kind === 'reconnecting'
      ? {
          key: 'SSH 连接已断开（{reason}），正在重新连接…',
          values: { reason },
        }
      : {
          key: 'SSH 连接已断开（{reason}），任务已中止，可从终端标签重启',
          values: { reason },
        }
  }
  return kind === 'reconnecting'
    ? { key: 'SSH 连接已断开，正在重新连接…' }
    : { key: 'SSH 连接已断开，任务已中止，可从终端标签重启' }
}

/**
 * OpenCode (and similar TUIs) often tear down the whole ConPTY on exit.
 * Interactive shells / profile tabs should get a fresh prompt instead of
 * staying on「进程已退出」. One-shot run-config tasks stay exited.
 */
export function shouldKeepShellAfterExit(
  tab: Pick<TerminalTab, 'shellKind' | 'launchCommand' | 'profileId'>,
): boolean {
  if (tab.shellKind && tab.shellKind !== 'interactive') return false
  return true
}

/**
 * What to do when a restored view mounts on an exited tab.
 * A still-open session is not a disconnect. An interactive shell whose
 * process is gone is started again. Only a finished one-shot task stays locked.
 */
export function restoredExitRecovery(options: {
  awaitingRestoreSpawn: boolean
  sessionOpen: boolean
  keepShell: boolean
}): 'await-spawn' | 'reattach' | 'respawn' | 'locked' {
  if (options.awaitingRestoreSpawn) return 'await-spawn'
  if (options.sessionOpen) return 'reattach'
  if (options.keepShell) return 'respawn'
  return 'locked'
}

/** SSH 断线后重开 Shell 的退避间隔；全部失败后停在已退出，可从标签手动重启。 */
export const SSH_TERMINAL_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000] as const

/** 第 `attempt` 次（从 0 开始）重连前的等待毫秒数；用完返回 null。 */
export function sshTerminalReconnectDelay(attempt: number): number | null {
  return SSH_TERMINAL_RECONNECT_DELAYS_MS[attempt] ?? null
}
