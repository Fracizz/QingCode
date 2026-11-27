import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearToasts, dismissToast, MAX_TOASTS, toast, toastDuration, useToasts } from './toast'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  clearToasts()
  vi.useRealTimers()
})

const items = () => useToasts.getState().items

it('按语气和长度估算时长，最长 8 秒', () => {
  expect(toastDuration('已复制', 'ok')).toBe(2500)
  expect(toastDuration('失败', 'error')).toBe(5000)
  expect(toastDuration('长'.repeat(500), 'info')).toBe(8000)
})

it('到时自动关闭，可手动提前关闭', () => {
  const first = toast('已保存', { tone: 'ok' })
  const second = toast('需要确认', { duration: 0 })
  expect(items().map((item) => item.message)).toEqual(['已保存', '需要确认'])
  vi.advanceTimersByTime(2500)
  expect(items().map((item) => item.id)).toEqual([second])
  vi.advanceTimersByTime(60_000)
  expect(items()).toHaveLength(1)
  dismissToast(second)
  expect(items()).toEqual([])
  expect(first).not.toBe(second)
})

it('同文同语气合并并重新计时，同 key 原地替换内容', () => {
  const id = toast('网络中断', { tone: 'error' })
  vi.advanceTimersByTime(4000)
  expect(toast('网络中断', { tone: 'error' })).toBe(id)
  vi.advanceTimersByTime(4000)
  expect(items()).toHaveLength(1)
  vi.advanceTimersByTime(1000)
  expect(items()).toEqual([])

  const size = toast('字号 14px', { key: 'font', duration: 1000 })
  expect(toast('字号 16px', { key: 'font', duration: 1000 })).toBe(size)
  expect(items().map((item) => item.message)).toEqual(['字号 16px'])
})

it('超过上限时挤掉最早的一条，空文本不显示', () => {
  expect(toast('   ')).toBe(0)
  for (let index = 0; index < MAX_TOASTS + 2; index++) toast(`提示 ${index}`)
  expect(items().map((item) => item.message)).toEqual(['提示 2', '提示 3', '提示 4'])
})
