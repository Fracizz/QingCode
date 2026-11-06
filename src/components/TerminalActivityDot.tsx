import { useSyncExternalStore } from 'react'
import {
  getTerminalActivityPhase,
  subscribeTerminalActivity,
} from '@/lib/terminal/terminalActivity'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

const SLOT_CLASS = 'inline-flex h-3 w-3 flex-shrink-0 items-center justify-center'

/** 标签右侧状态位（宽 12px，见 DESIGN.md）：待机时留空，状态变化不会让标签宽度跳动。 */
export default function TerminalActivityDot({ terminalId }: { terminalId: string }) {
  const { t } = useI18n()
  const phase = useSyncExternalStore(subscribeTerminalActivity, () =>
    getTerminalActivityPhase(terminalId),
  )
  if (phase === 'idle') return <span className={SLOT_CLASS} aria-hidden="true" />
  const label = phase === 'running' ? t('运行中') : t('已停止，请查看')
  return (
    <Tooltip label={label} side="top" wrapperClassName={SLOT_CLASS}>
      <span
        role="img"
        aria-label={label}
        data-terminal-activity={phase}
        className={`block h-1.5 w-1.5 rounded-full ${
          phase === 'running' ? 'dirty-pulse bg-accent' : 'bg-ok'
        }`}
      />
    </Tooltip>
  )
}
