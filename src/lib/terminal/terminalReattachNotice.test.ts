import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '../../store/projectStore'
import {
  noteTerminalReattached,
  REATTACH_NOTICE_SETTLE_MS,
  resetReattachNoticeForTests,
  trackStartupReattach,
} from './terminalReattachNotice'

describe('terminalReattachNotice', () => {
  const pushToast = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    resetReattachNoticeForTests()
    pushToast.mockReset()
    useProjectStore.setState({ pushToast })
  })

  afterEach(() => {
    resetReattachNoticeForTests()
    vi.useRealTimers()
  })

  it('并发接回的多个终端只汇总提示一次', () => {
    trackStartupReattach(['a', 'b', 'c'])
    noteTerminalReattached('a')
    vi.advanceTimersByTime(REATTACH_NOTICE_SETTLE_MS - 1)
    noteTerminalReattached('b')
    vi.advanceTimersByTime(REATTACH_NOTICE_SETTLE_MS)
    expect(pushToast).toHaveBeenCalledTimes(1)
    expect(pushToast.mock.calls[0][0]).toBe('success')
    expect(pushToast.mock.calls[0][1]).toContain('2')

    // 提示过之后，后来接回的（如切到项目、断线重连）不再提示。
    noteTerminalReattached('c')
    trackStartupReattach(['d'])
    noteTerminalReattached('d')
    vi.advanceTimersByTime(REATTACH_NOTICE_SETTLE_MS * 2)
    expect(pushToast).toHaveBeenCalledTimes(1)
  })

  it('未登记的标签接回不计数、不提示', () => {
    noteTerminalReattached('x')
    vi.advanceTimersByTime(REATTACH_NOTICE_SETTLE_MS * 2)
    expect(pushToast).not.toHaveBeenCalled()
  })
})
