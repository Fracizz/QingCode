import { isSshResource, safeInvoke } from '@/lib/tauri'
import { useTerminalStore } from '@/store/terminalStore'
import type { TerminalTab } from '@/types'
import {
  clearTerminalTitleSignal,
  getTerminalActivityState,
  nextTerminalActivity,
  publishTerminalActivity,
  terminalTitleSignal,
  type TerminalActivityState,
} from './terminalActivity'
import { isOneShotTaskTerminal } from './terminalBusy'

/** 不追求实时：进程探测要枚举全部进程，普通节奏 5 秒，窗口不可见时放慢。 */
const POLL_MS = 5000
const HIDDEN_POLL_MS = 15000
/** 切换标签或退出时只重算状态、不探测进程，所以可以及时清除「未查看」。 */
const SWEEP_DEBOUNCE_MS = 200

/** 只有需要靠子进程判断的本机终端才探测；SSH 终端的进程不在本机。 */
function needsProcessProbe(tab: TerminalTab, now: number): boolean {
  return (
    tab.status === 'running' &&
    !isSshResource(tab.cwd) &&
    !isOneShotTaskTerminal(tab) &&
    !terminalTitleSignal(tab.id, now).agentTitle
  )
}

/** 开启后运行；返回的函数停止全部定时器并清空状态。关闭时没有任何轮询。 */
export function startTerminalActivityTracker(
  isOnScreen: (terminalId: string) => boolean,
): () => void {
  let stopped = false
  let pollTimer: number | undefined
  let sweepTimer: number | undefined
  const hasChildren = new Map<string, boolean>()

  const sweep = () => {
    const now = Date.now()
    const focused = document.hasFocus()
    const next = new Map<string, TerminalActivityState>()
    for (const tab of useTerminalStore.getState().terminals) {
      // 进程没了，旧标题不再代表任何程序；否则重启后的普通 Shell 仍被当成 Agent。
      if (tab.status === 'exited' || tab.status === 'starting') clearTerminalTitleSignal(tab.id)
      next.set(
        tab.id,
        nextTerminalActivity(
          getTerminalActivityState(tab.id),
          {
            status: tab.status,
            ...terminalTitleSignal(tab.id, now),
            oneShot: isOneShotTaskTerminal(tab),
            hasChildren: hasChildren.get(tab.id) === true,
            viewed: focused && isOnScreen(tab.id),
          },
          now,
        ),
      )
    }
    publishTerminalActivity(next)
  }

  const poll = async () => {
    const now = Date.now()
    const ids = useTerminalStore
      .getState()
      .terminals.filter(tab => needsProcessProbe(tab, now))
      .map(tab => tab.id)
    const probed = new Set(ids)
    for (const id of hasChildren.keys()) if (!probed.has(id)) hasChildren.delete(id)
    if (ids.length > 0) {
      try {
        const result = await safeInvoke<Record<string, boolean>>(
          '查询终端运行状态',
          'terminal_child_process_states',
          { ids },
        )
        for (const id of ids) hasChildren.set(id, result[id] === true)
      } catch {
        // 探测失败时沿用上一轮结果，不把未知当成任务结束。
      }
    }
    if (stopped) return
    sweep()
    pollTimer = window.setTimeout(() => void poll(), document.hidden ? HIDDEN_POLL_MS : POLL_MS)
  }

  const scheduleSweep = () => {
    if (sweepTimer !== undefined) return
    sweepTimer = window.setTimeout(() => {
      sweepTimer = undefined
      if (!stopped) sweep()
    }, SWEEP_DEBOUNCE_MS)
  }

  const unsubscribeStore = useTerminalStore.subscribe((state, prev) => {
    if (
      state.terminals !== prev.terminals ||
      state.activeTerminalId !== prev.activeTerminalId ||
      state.secondaryTerminalId !== prev.secondaryTerminalId ||
      state.blTerminalId !== prev.blTerminalId ||
      state.brTerminalId !== prev.brTerminalId
    ) {
      scheduleSweep()
    }
  })
  window.addEventListener('focus', scheduleSweep)
  void poll()

  return () => {
    stopped = true
    window.clearTimeout(pollTimer)
    window.clearTimeout(sweepTimer)
    unsubscribeStore()
    window.removeEventListener('focus', scheduleSweep)
    publishTerminalActivity(new Map())
  }
}
