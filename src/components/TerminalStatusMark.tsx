import { useCallback, useSyncExternalStore } from 'react'
import {
  getTerminalProgramBusySnapshot,
  subscribeTerminalProgramActivity,
} from '@/lib/terminal/terminalProgramActivity'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

// 下移 1px 做光学对齐：几何居中时，正文（Segoe UI 上伸部高于下伸部、含 p/g 等下伸字母）
// 的墨迹中心比行框中心低 0.5–1.5px，标记会显得偏上。
const SLOT_CLASS = 'inline-flex h-4 w-4 flex-shrink-0 translate-y-px items-center justify-center'

/**
 * 终端列表行首的固定状态位（16px，与项目图标同宽），每一行都有标记，扫读时左侧对齐成一列：
 * 运行中 `accent` 转圈 > 有新结果 `brand` 实心点 > 空闲淡灰点；已退出与待恢复都是空心圈（后者没有行尾的重启按钮）。
 * 转圈、点与圈统一 8px 外径，只靠颜色（强调色/品牌色/淡灰）、实心/空心与转动区分，整列大小一致。
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
        {/* 与已退出同为空心圈（虚线圈在小尺寸下发糊），但边框细到 1px：非当前项目的终端整排都是这个状态，需更安静；
            两者仍主要靠行尾（已退出才有重启与「已退出」）区分。 */}
        <span
          role="img"
          aria-label={label}
          data-terminal-awaiting-restore={terminalId}
          className="block h-2 w-2 rounded-full border border-term-list-meta"
        />
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
          className="block h-2 w-2 rounded-full border-[1.5px] border-term-list-meta"
        />
      </Tooltip>
    )
  }
  if (showActivity && busy) {
    const label = t('运行中')
    return (
      <Tooltip label={label} side="top" wrapperClassName={SLOT_CLASS}>
        <span role="img" aria-label={label} data-terminal-activity="running" className="flex text-accent">
          {/* 不用 LoaderCircle：它是 3/4 缺口弧，墨迹重心随旋转角度偏移，截到某一帧时会显得比文字偏低或偏左。
              改为淡色整圈轨道 + 1/4 弧旋转，任何时刻轮廓都是以槽位为中心的完整圆。
              外径 8px、线宽 1.5px，与已退出空心圈同尺寸，整列标记大小一致，只靠颜色与转动区分。 */}
          <svg width={8} height={8} viewBox="0 0 8 8" fill="none" className="animate-spin" aria-hidden="true">
            <circle cx="4" cy="4" r="3.25" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
            <path d="M4 .75a3.25 3.25 0 0 1 3.25 3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
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
  // 空闲：直径与空心圈一致（8px），只靠淡色弱化，实心/空心区分状态；与其他状态一样悬停给出说明。
  const label = t('空闲')
  return (
    <Tooltip label={label} side="top" wrapperClassName={SLOT_CLASS}>
      <span
        role="img"
        aria-label={label}
        data-terminal-status="idle"
        className="block h-2 w-2 rounded-full bg-term-list-meta/60"
      />
    </Tooltip>
  )
}
