import { useEffect, useState } from 'react'
import {
  TERMINAL_OVERLAY_NOTICE_MS,
  subscribeTerminalOverlayNotice,
  type TerminalOverlayNotice,
} from '@/lib/terminal/terminalOverlayNotice'

/**
 * 终端连接状态浮层：叠在 xterm 上方而非写入缓冲，前台 TUI 的画面不受影响。
 * 不拦截鼠标，避免挡住 TUI 的点击与选择。
 */
export default function TerminalConnectionNotice({ terminalId, offsetForSearch = false }: {
  terminalId: string
  offsetForSearch?: boolean
}) {
  // 按终端 id 记录，切换终端时旧终端的提示自然失效，无需在 effect 里重置。
  const [state, setState] = useState<{ id: string; notice: TerminalOverlayNotice | null } | null>(null)
  const notice = state?.id === terminalId ? state.notice : null

  useEffect(() => subscribeTerminalOverlayNotice(terminalId, next => {
    setState({ id: terminalId, notice: next })
  }), [terminalId])

  useEffect(() => {
    if (!notice || notice.sticky) return
    const remaining = Math.max(0, TERMINAL_OVERLAY_NOTICE_MS - (Date.now() - notice.at))
    const timer = window.setTimeout(() => {
      setState(current => (current?.notice?.serial === notice.serial ? { ...current, notice: null } : current))
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [notice])

  if (!notice) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="terminal-connection-notice"
      className={`pointer-events-none absolute right-3 z-10 max-w-[min(480px,calc(100%-24px))] rounded border border-border bg-bg-deep/90 px-2.5 py-1 text-ui-sm text-fg-muted shadow-sm ${
        offsetForSearch ? 'top-12' : 'top-2'
      }`}
    >
      {notice.text}
    </div>
  )
}
