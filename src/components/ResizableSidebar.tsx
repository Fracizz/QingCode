import type { ReactNode } from 'react'
import ScmResizableColumn from './ScmResizableColumn'
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  getSidebarMaxWidth,
  getSidebarMinWidth,
} from '../lib/sidebarLayout'
import { sidebarResizerHint } from '../lib/panelLayout'
import { useI18n } from '../lib/i18n'

interface Props {
  width: number
  /** 当前是设置 / 源代码管理整页：使用整页的宽度范围。 */
  page?: boolean
  onWidthChange: (width: number) => void
  children: ReactNode
  className?: string
}

/** Share the frame-batched preview and end-of-drag persistence used by SCM. */
export default function ResizableSidebar({
  width,
  page = false,
  onWidthChange,
  children,
  className,
}: Props) {
  const { t } = useI18n()
  return (
    <ScmResizableColumn
      width={width}
      minWidth={clampSidebarWidth(getSidebarMinWidth(page), page)}
      maxWidth={getSidebarMaxWidth(page)}
      defaultWidth={SIDEBAR_DEFAULT_WIDTH}
      constrainToParent={false}
      // 侧栏宽度会改变右侧终端尺寸，拖动时需要冻结终端画面防闪烁。
      freezeTerminals
      borderColorClass="border-divider"
      onWidthChange={next => onWidthChange(clampSidebarWidth(next, page))}
      tooltip={sidebarResizerHint(width, t, page)}
      className={className}
    >
      {children}
    </ScmResizableColumn>
  )
}
