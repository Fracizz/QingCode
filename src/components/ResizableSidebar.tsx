import type { ReactNode } from 'react'
import ScmResizableColumn from './ScmResizableColumn'
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../lib/sidebarLayout'
import { sidebarResizerHint } from '../lib/panelLayout'
import { useI18n } from '../lib/i18n'

/** 自定义宽度范围（如终端工作台左侧整页）；缺省使用普通侧栏范围。 */
export interface SidebarWidthBounds {
  min: number
  max: number
  defaultWidth: number
  clamp: (width: number) => number
}

interface Props {
  width: number
  onWidthChange: (width: number) => void
  children: ReactNode
  className?: string
  bounds?: SidebarWidthBounds
}

/** Share the frame-batched preview and end-of-drag persistence used by SCM. */
export default function ResizableSidebar({
  width,
  onWidthChange,
  children,
  className,
  bounds,
}: Props) {
  const { t } = useI18n()
  const clamp = bounds?.clamp ?? clampSidebarWidth
  return (
    <ScmResizableColumn
      width={width}
      minWidth={bounds?.min ?? SIDEBAR_MIN_WIDTH}
      maxWidth={bounds ? bounds.max : clampSidebarWidth(SIDEBAR_MAX_WIDTH)}
      defaultWidth={bounds?.defaultWidth ?? SIDEBAR_DEFAULT_WIDTH}
      constrainToParent={false}
      // 侧栏宽度会改变右侧终端尺寸，拖动时需要冻结终端画面防闪烁。
      freezeTerminals
      borderColorClass="border-divider"
      onWidthChange={next => onWidthChange(clamp(next))}
      tooltip={
        bounds
          ? t('拖动调整侧边栏宽度 · {min}–{max}px · 当前 {current}px', {
              min: bounds.min,
              max: bounds.max,
              current: Math.round(width),
            })
          : sidebarResizerHint(width, t)
      }
      className={className}
    >
      {children}
    </ScmResizableColumn>
  )
}
