import { useCallback, useSyncExternalStore } from 'react'
import { CircleDashed, LoaderCircle } from 'lucide-react'
import {
  getTerminalProgramBusySnapshot,
  subscribeTerminalProgramActivity,
} from '@/lib/terminal/terminalProgramActivity'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

const SLOT_CLASS = 'inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center'

/**
 * 终端列表行首的固定状态位（14px），每一行都有标记，扫读时左侧对齐成一列：
 * 运行中 `accent` 转圈 > 有新结果 `brand` 实心点 > 空闲淡灰小点；已退出为空心圈，待恢复为虚线圈。
 * 关闭「标签运行状态」设置后不显示运行中和新结果，退回空闲点；已退出与待恢复不受影响。
 */
export default function TerminalStatusMark({
  terminalId,
  exited,
  awaitingRestore = false,
  attention = false,
  showActivity = true,
}: {
  terminalId: string
  exited: boolean
  awaitingRestore?: boolean
  attention?: boolean
  showActivity?: boolean
}) {
  const { t } = useI18n()
  const subscribe = useCallback(
    (onChange: () => void) =>
      subscribeTerminalProgramActivity(id => {
        if (id === terminalId) onChange()
      }),
    [terminalId],
  )
  const busy = useSyncExternalStore(subscribe, () => getTerminalProgramBusySnapshot(terminalId))

  if (awaitingRestore) {
    const label = t('切换到项目后恢复')
    return (
      <Tooltip label={label} side="top" wrapperClassName={SLOT_CLASS}>
        <span role="img" aria-label={label} data-terminal-awaiting-restore={terminalId} className="flex text-term-list-meta">
          <CircleDashed size={10} strokeWidth={2.25} aria-hidden="true" />
        </span>
      </Tooltip>
    )
  }
  if (exited) {
    const label = t('已退出')
    return (
      <Tooltip label={label} side="top" wrapperClassName={SLOT_CLASS}>
        <span
          role="img"
          aria-label={label}
          data-terminal-status="exited"
          className="block h-[7px] w-[7px] rounded-full border-[1.5px] border-term-list-meta"
        />
      </Tooltip>
    )
  }
  if (showActivity && busy) {
    const label = t('运行中')
    return (
      <Tooltip label={label} side="top" wrapperClassName={SLOT_CLASS}>
        <span role="img" aria-label={label} data-terminal-activity="running" className="flex text-accent">
          <LoaderCircle size={12} strokeWidth={2.5} className="animate-spin" aria-hidden="true" />
        </span>
      </Tooltip>
    )
  }
  if (showActivity && attention) {
    const label = t('有新结果待查看')
    return (
      <Tooltip label={label} side="top" wrapperClassName={SLOT_CLASS}>
        <span
          role="img"
          aria-label={label}
          data-terminal-activity="attention"
          className="block h-2 w-2 rounded-full bg-brand"
        />
      </Tooltip>
    )
  }
  // 空闲是常态，不加悬停提示，避免满屏提示打扰；只保留一个弱化的点占住这一列。
  return (
    <span className={SLOT_CLASS} aria-hidden="true">
      <span data-terminal-status="idle" className="block h-[5px] w-[5px] rounded-full bg-term-list-meta/45" />
    </span>
  )
}
