import { expect, it } from 'vitest'
import { bindChatPinch, fitChatFont, saveChatFont } from './chatFont'

it('双指缩放按距离比调整字号，保留单指滚动并清理监听', () => {
  const root = Object.assign(new EventTarget(), {
    contains: () => true,
    style: { setProperty: (_key: string, value: string) => { size = value } },
  })
  let size = ''
  const close = bindChatPinch(root as unknown as HTMLElement)
  const touch = (type: string, positions: number[]) => root.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
    touches: positions.map((clientX, identifier) => ({ identifier, clientX, clientY: 0, target: root })),
  }))
  expect(touch('touchstart', [10])).toBe(true)
  expect(touch('touchstart', [0, 100])).toBe(false)
  touch('touchmove', [0, 20])
  expect(size).toBe('8px')
  touch('touchmove', [0, 200])
  // 默认 16px，两指距离翻倍到 32px（上限）。
  expect(size).toBe('32px')
  touch('touchcancel', [])
  close()
  expect(touch('touchstart', [0, 100])).toBe(true)
  expect(fitChatFont(200)).toBe(32)
})

it('缩放中回报当前字号，手势结束回报 null 以隐藏提示', () => {
  const root = Object.assign(new EventTarget(), {
    contains: () => true,
    style: { setProperty: () => undefined },
  })
  saveChatFont(14)
  const reports: Array<number | null> = []
  const close = bindChatPinch(root as unknown as HTMLElement, (size) => reports.push(size))
  const touch = (type: string, positions: number[]) => root.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
    touches: positions.map((clientX, identifier) => ({ identifier, clientX, clientY: 0, target: root })),
  }))
  touch('touchstart', [0, 100])
  touch('touchmove', [0, 100])
  touch('touchmove', [0, 150])
  touch('touchend', [])
  close()
  // 越过 24px 阈值后按 150 / 124 缩放。
  expect(reports).toEqual([17, null])
})

it('轻触、小幅抖动和三指手势不触发缩放', () => {
  const root = Object.assign(new EventTarget(), {
    contains: () => true,
    style: { setProperty: () => undefined },
  })
  saveChatFont(14)
  const reports: Array<number | null> = []
  const close = bindChatPinch(root as unknown as HTMLElement, (size) => reports.push(size))
  const touch = (type: string, positions: number[]) => root.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
    touches: positions.map((clientX, identifier) => ({ identifier, clientX, clientY: 0, target: root })),
  }))
  touch('touchstart', [0, 100])
  touch('touchmove', [0, 120])
  touch('touchend', [])
  // 三指落下后抬起一指，剩下两指继续移动也忽略。
  touch('touchstart', [0])
  touch('touchstart', [0, 100])
  touch('touchstart', [0, 100, 200])
  touch('touchend', [0, 100])
  touch('touchmove', [0, 300])
  touch('touchend', [])
  expect(reports).toEqual([])
  // 全部抬起后下一次双指缩放照常生效。
  touch('touchstart', [0, 100])
  touch('touchmove', [0, 150])
  touch('touchend', [])
  close()
  expect(reports).toEqual([17, null])
})
