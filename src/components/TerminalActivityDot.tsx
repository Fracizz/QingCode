import { useCallback, useSyncExternalStore } from 'react'
import {
  getTerminalProgramBusySnapshot,
  subscribeTerminalProgramActivity,
} from '@/lib/terminal/terminalProgramActivity'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

const SLOT_CLASS = 'inline-flex h-3 w-3 flex-shrink-0 items-center justify-center'

/**
 * 标签右侧状态位（宽 12px，见 DESIGN.md）：程序正在工作时显示呼吸点，其余时间留空，
 * 状态变化不会让标签宽度跳动。只在该终端状态翻转时重渲染。
 */
export default function TerminalActivityDot({
  terminalId,
  exited,
  attention = false,
}: {
  terminalId: string
  exited: boolean
  /** 后台任务已结束、等待查看；运行中优先显示呼吸点。 */
  attention?: boolean
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
  if (exited || !busy) {
    if (!attention) return <span className={SLOT_CLASS} aria-hidden="true" />
    const attentionLabel = t('有新结果待查看')
    return (
      <Tooltip label={attentionLabel} side="top" wrapperClassName={SLOT_CLASS}>
        <span
          role="img"
          aria-label={attentionLabel}
          data-terminal-activity="attention"
          className="block h-1.5 w-1.5 rounded-full bg-brand"
        />
      </Tooltip>
    )
  }
  const label = t('运行中')
  return (
    <Tooltip label={label} side="top" wrapperClassName={SLOT_CLASS}>
      <span
        role="img"
        aria-label={label}
        data-terminal-activity="running"
        className="dirty-pulse block h-1.5 w-1.5 rounded-full bg-accent"
      />
    </Tooltip>
  )
}
