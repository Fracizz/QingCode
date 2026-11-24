import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '../../store/projectStore'
import {
  noteTerminalReattaching,
  resetReattachNoticeForTests,
  trackStartupReattach,
} from './terminalReattachNotice'

describe('terminalReattachNotice', () => {
  const pushToast = vi.fn()

  beforeEach(() => {
    resetReattachNoticeForTests()
    pushToast.mockReset()
    useProjectStore.setState({ pushToast })
  })

  it('启动后第一个终端开始接回时提示一次，不显示个数', () => {
    trackStartupReattach(['a', 'b'])
    noteTerminalReattaching('a')
    noteTerminalReattaching('b')
    expect(pushToast).toHaveBeenCalledTimes(1)
    expect(pushToast.mock.calls[0][0]).toBe('info')
    expect(pushToast.mock.calls[0][1]).not.toMatch(/\d/)

    // 提示过之后，后来登记并接回的（如断线重连）不再提示。
    trackStartupReattach(['c'])
    noteTerminalReattaching('c')
    expect(pushToast).toHaveBeenCalledTimes(1)
  })

  it('未登记的标签接回不提示', () => {
    noteTerminalReattaching('x')
    expect(pushToast).not.toHaveBeenCalled()
  })
})
