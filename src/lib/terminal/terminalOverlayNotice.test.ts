import { describe, expect, it } from 'vitest'
import {
  TERMINAL_OVERLAY_NOTICE_MS,
  activeTerminalOverlayNotice,
  clearTerminalOverlayNotice,
  publishTerminalOverlayNotice,
  subscribeTerminalOverlayNotice,
  type TerminalOverlayNotice,
} from './terminalOverlayNotice'

describe('terminal overlay notice', () => {
  it('delivers notices to subscribers and replays the active one on late subscribe', () => {
    const received: Array<TerminalOverlayNotice | null> = []
    const unsubscribe = subscribeTerminalOverlayNotice('t-live', notice => received.push(notice))
    publishTerminalOverlayNotice('t-live', '正在重新连接…', { sticky: true })
    expect(received.map(notice => notice?.text)).toEqual(['正在重新连接…'])
    unsubscribe()

    const late: Array<TerminalOverlayNotice | null> = []
    subscribeTerminalOverlayNotice('t-live', notice => late.push(notice))()
    expect(late[0]).toMatchObject({ text: '正在重新连接…', sticky: true })
    clearTerminalOverlayNotice('t-live')
  })

  it('keeps sticky notices but expires transient ones', () => {
    const now = 1_000_000
    publishTerminalOverlayNotice('t-sticky', '重连中', { sticky: true, now })
    expect(activeTerminalOverlayNotice('t-sticky', now + 60_000)?.text).toBe('重连中')

    publishTerminalOverlayNotice('t-transient', '已重新连接', { now })
    expect(activeTerminalOverlayNotice('t-transient', now + 10)?.text).toBe('已重新连接')
    expect(activeTerminalOverlayNotice('t-transient', now + TERMINAL_OVERLAY_NOTICE_MS)).toBeNull()
    clearTerminalOverlayNotice('t-sticky')
  })

  it('notifies null on clear and isolates terminals', () => {
    const a: Array<TerminalOverlayNotice | null> = []
    const b: Array<TerminalOverlayNotice | null> = []
    const offA = subscribeTerminalOverlayNotice('t-a', notice => a.push(notice))
    const offB = subscribeTerminalOverlayNotice('t-b', notice => b.push(notice))
    publishTerminalOverlayNotice('t-a', 'x', { sticky: true })
    clearTerminalOverlayNotice('t-a')
    clearTerminalOverlayNotice('t-a')
    expect(a.map(notice => notice?.text ?? null)).toEqual(['x', null])
    expect(b).toEqual([])
    offA()
    offB()
  })
})
