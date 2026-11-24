// 刻意使用 node 环境（没有 window），模拟 jsdom 已被 Vitest 拆卸后持久化定时器才触发的场景。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleTerminalOutputPersist } from './outputBuffer'

describe('scheduleTerminalOutputPersist', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not throw when the timer fires after window is gone', () => {
    expect(typeof window).toBe('undefined')
    vi.useFakeTimers()
    scheduleTerminalOutputPersist()
    expect(() => vi.runOnlyPendingTimers()).not.toThrow()
    // 定时器已清空，后续调度不被卡住。
    scheduleTerminalOutputPersist()
    expect(vi.getTimerCount()).toBe(1)
  })
})
