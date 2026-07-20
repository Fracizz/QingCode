import type { ReactNode } from 'react'
import Tooltip from './Tooltip'
import { useStatusBarRowTop } from './statusBarRowContext'

type Props = {
  label: string
  delay?: number
  onShow?: () => void
  onHide?: () => void
  wrapperClassName?: string
  children: ReactNode
}

/**
 * Status-bar tip: opens above the trigger with a downward caret, clear of the bar.
 * Prefer this over raw `Tooltip` for anything in `StatusBar`.
 *
 * Uses {@link useStatusBarRowTop} so the caret tip stays 2px above the status-bar row top.
 */
export default function StatusTip({
  label,
  delay,
  onShow,
  onHide,
  wrapperClassName = '',
  children,
}: Props) {
  const statusBarRowTop = useStatusBarRowTop()
  return (
    <Tooltip
      label={label}
      side="top"
      arrow
      anchor="wrapper"
      clearanceTop={statusBarRowTop}
      delay={delay}
      onShow={onShow}
      onHide={onHide}
      wrapperClassName={`inline-flex self-stretch items-center shrink-0 ${wrapperClassName}`.trim()}
    >
      {children}
    </Tooltip>
  )
}
