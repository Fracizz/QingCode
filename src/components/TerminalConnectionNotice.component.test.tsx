// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalConnectionNotice from './TerminalConnectionNotice'
import {
  TERMINAL_OVERLAY_NOTICE_MS,
  clearTerminalOverlayNotice,
  publishTerminalOverlayNotice,
} from '@/lib/terminal/terminalOverlayNotice'

describe('terminal connection overlay notice', () => {
  afterEach(() => {
    vi.useRealTimers()
    clearTerminalOverlayNotice('term-1')
  })

  it('shows reconnect state as an overlay that never intercepts the pointer', () => {
    render(<TerminalConnectionNotice terminalId="term-1" />)
    expect(screen.queryByTestId('terminal-connection-notice')).toBeNull()
    act(() => {
      publishTerminalOverlayNotice('term-1', 'SSH 连接已断开，正在重新连接…', { sticky: true })
    })
    const notice = screen.getByTestId('terminal-connection-notice')
    expect(notice).toHaveTextContent('正在重新连接')
    expect(notice).toHaveAttribute('role', 'status')
    expect(notice.className).toContain('pointer-events-none')
    expect(notice).not.toHaveAttribute('title')
  })

  it('replaces the sticky reconnect notice with a transient one that auto-hides', () => {
    vi.useFakeTimers()
    render(<TerminalConnectionNotice terminalId="term-1" />)
    act(() => {
      publishTerminalOverlayNotice('term-1', '正在重新连接…', { sticky: true })
    })
    act(() => {
      vi.advanceTimersByTime(TERMINAL_OVERLAY_NOTICE_MS * 3)
    })
    expect(screen.getByTestId('terminal-connection-notice')).toHaveTextContent('正在重新连接')
    act(() => {
      publishTerminalOverlayNotice('term-1', '已重新连接')
    })
    expect(screen.getByTestId('terminal-connection-notice')).toHaveTextContent('已重新连接')
    act(() => {
      vi.advanceTimersByTime(TERMINAL_OVERLAY_NOTICE_MS + 10)
    })
    expect(screen.queryByTestId('terminal-connection-notice')).toBeNull()
  })

  it('hides immediately when the notice is cleared (e.g. terminal exited)', () => {
    render(<TerminalConnectionNotice terminalId="term-1" />)
    act(() => {
      publishTerminalOverlayNotice('term-1', '正在重新连接…', { sticky: true })
    })
    act(() => {
      clearTerminalOverlayNotice('term-1')
    })
    expect(screen.queryByTestId('terminal-connection-notice')).toBeNull()
  })
})
