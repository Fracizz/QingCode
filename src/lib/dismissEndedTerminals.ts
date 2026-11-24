import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useTerminalStore } from '../store/terminalStore'
import { hasBackend } from './runtimeCapabilities'
import type { TerminalTab } from '../types'

/** 强制更新结束远端终端后，等待对应标签退出的最长时间；超时后不再自动移除。 */
export const DISMISS_ENDED_WINDOW_MS = 5 * 60_000

/** 广播给所有窗口：各窗口只持有自己项目的终端标签。 */
export const DISMISS_ENDED_TERMINALS_EVENT = 'qingcode://dismiss-ended-terminals'

/** 应用重启后尚未接回、但远端 PTY 仍在的标签：状态是「已退出」，实际会被更新一并结束。 */
function awaitingRestore(tab: TerminalTab): boolean {
  return tab.status === 'exited' && Boolean(tab.awaitingRestoreSpawn && tab.persistent && tab.ptyId)
}

/** 某连接上会被强制更新结束的终端标签：仍在运行的，以及待接回的。 */
export function liveTerminalIdsOnConnection(terminals: readonly TerminalTab[], connectionId: string): string[] {
  return terminals
    .filter(tab => tab.connectionId === connectionId && (tab.status !== 'exited' || awaitingRestore(tab)))
    .map(tab => tab.id)
}

/** 待移除集合里已经结束（或待接回、更新必然结束）的标签。 */
export function endedTerminalIds(terminals: readonly TerminalTab[], pending: ReadonlySet<string>): string[] {
  return terminals.filter(tab => pending.has(tab.id) && tab.status === 'exited').map(tab => tab.id)
}

/**
 * 强制更新远端服务会结束该连接上托管的全部终端：先记下此刻仍在运行或待接回的标签，
 * 之后它们一旦为「已退出」就直接关闭，不再留下已退出的窗口。
 * 进程已由更新结束，关闭时结束进程失败（服务正在重启）也照常移除。
 * 标签全部处理完或超过 windowMs 后停止监听；返回值可提前停止。
 */
export function dismissTerminalsWhenEnded(connectionId: string, windowMs = DISMISS_ENDED_WINDOW_MS): () => void {
  const store = useTerminalStore
  const pending = new Set(liveTerminalIdsOnConnection(store.getState().terminals, connectionId))
  if (pending.size === 0) return () => {}
  let stopped = false
  const sweep = (terminals: readonly TerminalTab[]) => {
    if (stopped) return
    // 用户已手动关掉的标签不再等待。
    const present = new Set(terminals.map(tab => tab.id))
    for (const id of pending) if (!present.has(id)) pending.delete(id)
    for (const id of endedTerminalIds(terminals, pending)) {
      pending.delete(id)
      void store.getState().closeTerminal(id, { ignoreKillError: true })
    }
    if (pending.size === 0) stop()
  }
  const unsubscribe = store.subscribe(state => sweep(state.terminals))
  const timer = setTimeout(() => stop(), windowMs)
  function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    unsubscribe()
  }
  // 待接回的标签本就是「已退出」，立即处理。
  sweep(store.getState().terminals)
  return stop
}

/** 通知所有窗口（含本窗口）移除该连接上将被强制更新结束的终端标签。 */
export async function broadcastDismissTerminalsWhenEnded(connectionId: string): Promise<void> {
  // 浏览器测试页没有跨窗口事件监听，只处理本窗口。
  if (!hasBackend()) {
    dismissTerminalsWhenEnded(connectionId)
    return
  }
  try {
    await emit(DISMISS_ENDED_TERMINALS_EVENT, { connectionId })
  } catch {
    // 事件通道不可用时至少处理本窗口。
    dismissTerminalsWhenEnded(connectionId)
  }
}

/** 每个窗口启动时注册：收到广播后处理本窗口的终端标签。 */
export function listenDismissEndedTerminals(): Promise<UnlistenFn> {
  return listen<unknown>(DISMISS_ENDED_TERMINALS_EVENT, event => {
    const payload = event.payload as { connectionId?: unknown } | null
    if (typeof payload?.connectionId === 'string' && payload.connectionId) dismissTerminalsWhenEnded(payload.connectionId)
  })
}
