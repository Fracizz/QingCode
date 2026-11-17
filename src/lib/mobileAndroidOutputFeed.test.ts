import { describe, expect, it, vi } from 'vitest'
import { createNativeRpc } from '../../mobile/android/web/nativeRpc.js'
import { createOutputFeed } from '../../mobile/android/web/outputFeed.js'

type Handlers = { onFrame: (frame: unknown) => void, onEnd: (result: unknown) => void }

/** 记录每次打开的推送，测试里手动推帧。 */
function fakeOpen() {
  const opened: { args: Record<string, unknown>, handlers: Handlers, cancel: ReturnType<typeof vi.fn> }[] = []
  const open = vi.fn((args: Record<string, unknown>, handlers: Handlers) => {
    const cancel = vi.fn()
    opened.push({ args, handlers, cancel })
    return cancel
  })
  return { open, opened }
}

const base = { id: 's1', tail: true, shared: true, profile: 'pc' }
const frame = (next: number, extra: Record<string, unknown> = {}) => ({ ok: true, data: { chunks: [], next, ...extra } })

describe('mobile output feed', () => {
  it('reuses one stream while each request continues from the previous frame', async () => {
    const { open, opened } = fakeOpen()
    const feed = createOutputFeed(open)
    const first = feed.next({ ...base, from: 0, latest: true })
    opened[0].handlers.onFrame(frame(5))
    // 帧先于请求到达时缓存起来，下次直接取。
    opened[0].handlers.onFrame(frame(9))
    expect((await first).next).toBe(5)
    expect((await feed.next({ ...base, from: 5, latest: false })).next).toBe(9)
    const third = feed.next({ ...base, from: 9, latest: false })
    opened[0].handlers.onFrame(frame(12))
    expect((await third).next).toBe(12)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('reopens when the caller asks for the latest screen, another cursor or another terminal', async () => {
    const { open, opened } = fakeOpen()
    const feed = createOutputFeed(open)
    const first = feed.next({ ...base, from: 0, latest: false })
    opened[0].handlers.onFrame(frame(3))
    await first
    void feed.next({ ...base, from: 3, latest: true }).catch(() => {})
    expect(open).toHaveBeenCalledTimes(2)
    expect(opened[0].cancel).toHaveBeenCalledTimes(1)
    void feed.next({ ...base, from: 7, latest: false }).catch(() => {})
    expect(open).toHaveBeenCalledTimes(3)
    void feed.next({ ...base, id: 's2', from: 7, latest: false }).catch(() => {})
    expect(open).toHaveBeenCalledTimes(4)
    expect(opened[3].args).toMatchObject({ id: 's2', from: 7 })
  })

  it('rejects with the desktop error and marks revoked devices', async () => {
    const { open, opened } = fakeOpen()
    const feed = createOutputFeed(open)
    const pending = feed.next({ ...base, from: 0, latest: false }).catch(error => error)
    opened[0].handlers.onFrame({ ok: false, error: '终端不存在。' })
    expect((await pending).message).toBe('终端不存在。')
    expect(feed.isOpen()).toBe(false)
    const revoked = feed.next({ ...base, from: 0, latest: false }).catch(error => error)
    opened[1].handlers.onEnd({ ok: false, error: '设备已移除', revoked: true })
    expect((await revoked).revoked).toBe(true)
  })

  it('resumes from the cursor after a normal end and fails when a stream ends before any frame', async () => {
    const { open, opened } = fakeOpen()
    const feed = createOutputFeed(open)
    const first = feed.next({ ...base, from: 0, latest: true })
    opened[0].handlers.onFrame(frame(4))
    await first
    const second = feed.next({ ...base, from: 4, latest: false })
    opened[0].handlers.onEnd({ ok: true, data: null })
    expect(opened[1].args).toMatchObject({ from: 4, latest: false })
    opened[1].handlers.onFrame(frame(6))
    expect((await second).next).toBe(6)
    const third = feed.next({ ...base, from: 6, latest: false }).catch(error => error)
    opened[1].handlers.onEnd({ ok: true, data: null })
    opened[2].handlers.onEnd({ ok: true, data: null })
    expect((await third).message).toBe('电脑端输出推送意外结束。')
  })

  it('drops a stream nobody reads instead of buffering without bound', async () => {
    const { open, opened } = fakeOpen()
    const feed = createOutputFeed(open, { maxQueued: 2 })
    const first = feed.next({ ...base, from: 0, latest: false })
    opened[0].handlers.onFrame(frame(1))
    await first
    for (const next of [2, 3, 4]) opened[0].handlers.onFrame(frame(next))
    expect(opened[0].cancel).toHaveBeenCalledTimes(1)
    expect(feed.isOpen()).toBe(false)
    void feed.next({ ...base, from: 1, latest: false }).catch(() => {})
    expect(opened[1].args).toMatchObject({ from: 1 })
  })

  it('aborts a pending read when closed', async () => {
    const { open } = fakeOpen()
    const feed = createOutputFeed(open)
    const pending = feed.next({ ...base, from: 0, latest: false }).catch(error => error)
    feed.close()
    expect((await pending).name).toBe('AbortError')
  })
})

describe('native output streams', () => {
  it('routes frames by id, ends once and stops after cancellation', () => {
    const native = { request: vi.fn(), cancel: vi.fn(), stream: vi.fn() }
    const rpc = createNativeRpc(native)
    expect(rpc.canStream).toBe(true)
    const onFrame = vi.fn()
    const onEnd = vi.fn()
    const cancel = rpc.stream('poll_stream', { id: 's1' }, { onFrame, onEnd })
    const [id, payload] = native.stream.mock.calls[0]
    expect(JSON.parse(payload)).toEqual({ op: 'poll_stream', id: 's1' })
    rpc.receiveStream(id, frame(1))
    rpc.endStream(id, { ok: true, data: null })
    rpc.endStream(id, { ok: true, data: null })
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
    cancel()
    expect(native.cancel).not.toHaveBeenCalled()
    const second = rpc.stream('poll_stream', {}, { onFrame, onEnd })
    second()
    rpc.receiveStream(native.stream.mock.calls[1][0], frame(2))
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(native.cancel).toHaveBeenCalledWith(native.stream.mock.calls[1][0])
  })

  it('reports bridges without streaming support', () => {
    expect(createNativeRpc({ request: vi.fn() }).canStream).toBe(false)
  })
})
