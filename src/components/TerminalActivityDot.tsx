import { useCallback, useSyncExternalStore } from 'react'
import {
  getTerminalProgramBusySnapshot,
  subscribeTerminalProgramActivity,
} from '@/lib/terminal/terminalProgramActivity'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

const SLOT_CLASS = 'inline-flex h-3 w-3 flex-shrink-0 items-center justify-center'
const DOT_SIZE_CLASS = { sm: 'h-1.5 w-1.5', md: 'h-2 w-2' } as const

/**
 * 标签右侧状态位（宽 12px，见 DESIGN.md）：程序正在工作时显示呼吸点，其余时间留空，
 * 状态变化不会让标签宽度跳动。只在该终端状态翻转时重渲染。
 */
export default function TerminalActivityDot({
  terminalId,
  exited,
  attention = false,
  awaitingRestore = false,
  size = 'sm',
}: {
  terminalId: string
  exited: boolean
  /** 后台任务已结束、等待查看；运行中优先显示呼吸点。 */
  attention?: boolean
  /** 重启应用后尚未恢复：进程还没启动，用空心点和运行中区分。 */
  awaitingRestore?: boolean
  /** 点的直径；状态位宽度不变，放大后也不会挤压标签。 */
  size?: keyof typeof DOT_SIZE_CLASS
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
  const dotSize = DOT_SIZE_CLASS[size]
  if (exited || !busy) {
    if (attention) {
      const attentionLabel = t('有新结果待查看')
      return (
        <Tooltip label={attentionLabel} side="top" wrapperClassName={SLOT_CLASS}>
          <span
            role="img"
            aria-label={attentionLabel}
            data-terminal-activity="attention"
            className={`block rounded-full bg-brand ${dotSize}`}
          />
        </Tooltip>
      )
    }
    if (awaitingRestore) {
      const restoreLabel = t('切换到项目后恢复')
      return (
        <Tooltip label={restoreLabel} side="top" wrapperClassName={SLOT_CLASS}>
          <span
            role="img"
            aria-label={restoreLabel}
            data-terminal-activity="restore"
            className={`block rounded-full border-[1.5px] border-fg-dim ${dotSize}`}
          />
        </Tooltip>
      )
    }
    return <span className={SLOT_CLASS} aria-hidden="true" />
  }
  const label = t('运行中')
  return (
    <Tooltip label={label} side="top" wrapperClassName={SLOT_CLASS}>
      <span
        role="img"
        aria-label={label}
        data-terminal-activity="running"
        className={`dirty-pulse block rounded-full bg-accent ${dotSize}`}
      />
    </Tooltip>
  )
}
