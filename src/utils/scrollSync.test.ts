import { describe, expect, it } from 'vitest'
import { syncScrollTop } from './scrollSync'

function fakeScroller(scrollHeight: number, clientHeight: number, scrollTop = 0) {
  return {
    scrollHeight,
    clientHeight,
    scrollTop,
  } as HTMLElement
}

describe('syncScrollTop', () => {
  it('maps proportional scroll between panes', () => {
    const source = fakeScroller(1000, 200, 400)
    const target = fakeScroller(500, 100, 0)
    syncScrollTop(source, target)
    expect(target.scrollTop).toBe(200)
  })

  it('resets target when source cannot scroll', () => {
    const source = fakeScroller(100, 100, 0)
    const target = fakeScroller(500, 100, 80)
    syncScrollTop(source, target)
    expect(target.scrollTop).toBe(0)
  })

  it('resets target when target cannot scroll', () => {
    const source = fakeScroller(1000, 200, 400)
    const target = fakeScroller(100, 100, 10)
    syncScrollTop(source, target)
    expect(target.scrollTop).toBe(0)
  })
})
