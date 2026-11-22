import { useTerminalStore } from '../store/terminalStore'
import type { TerminalTab } from '../types'

/** 强制更新结束远端终端后，等待对应标签退出的最长时间；超时后不再自动移除。 */
export const DISMISS_ENDED_WINDOW_MS = 5 * 60_000

/** 某连接上当前仍在运行（未退出）的终端标签。 */
export function liveTerminalIdsOnConnection(terminals: readonly TerminalTab[], connectionId: string): string[] {
  return terminals
    .filter(tab => tab.connectionId === connectionId && tab.status !== 'exited')
    .map(tab => tab.id)
}

/** 待移除集合里已经退出的标签。 */
export function endedTerminalIds(terminals: readonly TerminalTab[], pending: ReadonlySet<string>): string[] {
  return terminals.filter(tab => pending.has(tab.id) && tab.status === 'exited').map(tab => tab.id)
}

/**
 * 强制更新远端服务会结束该连接上托管的全部终端：先记下此刻仍在运行的标签，
 * 之后它们一旦变为「已退出」就直接关闭，不再留下已退出的窗口。
 * 标签全部处理完或超过 windowMs 后停止监听；返回值可提前停止（例如更新未真正开始）。
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
      void store.getState().closeTerminal(id)
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
  return stop
}
