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

interface Props {
  width: number
  onWidthChange: (width: number) => void
  children: ReactNode
  className?: string
}

/** Share the frame-batched preview and end-of-drag persistence used by SCM. */
export default function ResizableSidebar({ width, onWidthChange, children, className }: Props) {
  const { t } = useI18n()
  return (
    <ScmResizableColumn
      width={width}
      minWidth={SIDEBAR_MIN_WIDTH}
      maxWidth={clampSidebarWidth(SIDEBAR_MAX_WIDTH)}
      defaultWidth={SIDEBAR_DEFAULT_WIDTH}
      constrainToParent={false}
      onWidthChange={next => onWidthChange(clampSidebarWidth(next))}
      tooltip={sidebarResizerHint(width, t)}
      className={className}
    >
      {children}
    </ScmResizableColumn>
  )
}
