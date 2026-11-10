import { useCallback, useSyncExternalStore } from 'react'
import {
  getTerminalProgramBusySnapshot,
  subscribeTerminalProgramActivity,
} from '@/lib/terminal/terminalProgramActivity'
import { formatTerminalAge } from '@/lib/terminal/terminalLastActive'
import { useI18n } from '../lib/i18n'

const TICK_MS = 15_000

const clockListeners = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | null = null

/** 所有行共用一个时钟；没有行显示时间时停表。 */
function subscribeClock(listener: () => void) {
  clockListeners.add(listener)
  clockTimer ??= setInterval(() => {
    for (const notify of clockListeners) notify()
  }, TICK_MS)
  return () => {
    clockListeners.delete(listener)
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

let clockNow = Date.now()

/**
 * 时钟快照最多 15 秒变一次：连续读取得到同一个值（useSyncExternalStore 的要求），
 * 显示误差也不超过 15 秒。刚记录的活动可能比快照新，格式化时按「刚刚」处理。
 */
function readClock() {
  const now = Date.now()
  if (now - clockNow >= TICK_MS) clockNow = now
  return clockNow
}

/**
 * 列表行尾的相对时间（「4天」）。程序正在工作时不显示：状态列已有呼吸点，
 * 时间要等任务结束才有意义。
 */
export default function TerminalRowTime({
  terminalId,
  at,
  className = '',
}: {
  terminalId: string
  at: number
  className?: string
}) {
  const { t } = useI18n()
  const subscribeBusy = useCallback(
    (onChange: () => void) =>
      subscribeTerminalProgramActivity(id => {
        if (id === terminalId) onChange()
      }),
    [terminalId],
  )
  const busy = useSyncExternalStore(subscribeBusy, () => getTerminalProgramBusySnapshot(terminalId))
  const now = useSyncExternalStore(subscribeClock, readClock)
  if (busy) return null
  const label = formatTerminalAge(at, now, t)
  if (!label) return null
  return (
    <span
      aria-hidden="true"
      data-terminal-row-time={terminalId}
      className={`whitespace-nowrap pr-1 text-ui-xs tabular-nums text-term-list-meta ${className}`}
    >
      {label}
    </span>
  )
}
