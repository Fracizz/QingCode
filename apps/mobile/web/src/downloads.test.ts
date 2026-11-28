import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadOutcome, watchDownload } from './downloads'
import type { DeviceDownload } from './projectApi'

const job = (patch: Partial<DeviceDownload>): DeviceDownload => ({
  id: 'd1', name: 'app.apk', path: 'dist/app.apk', size: 10, written: 10, state: 'done', auto: true, ...patch,
})

describe('downloadOutcome', () => {
  it('完成时说明保存位置', () => {
    expect(downloadOutcome(job({ savedName: 'app (1).apk' }))).toEqual({ message: '已下载 app (1).apk，保存在 下载/QingCode', tone: 'ok' })
    expect(downloadOutcome(job({ auto: false }))?.message).toBe('已下载 app.apk')
  })

  it('失败带原因，进行中与取消不提示', () => {
    expect(downloadOutcome(job({ state: 'failed', error: '空间不足' }))).toEqual({ message: 'app.apk 下载失败：空间不足', tone: 'error' })
    expect(downloadOutcome(job({ state: 'running' }))).toBeNull()
    expect(downloadOutcome(job({ state: 'cancelled' }))).toBeNull()
  })
})

describe('watchDownload', () => {
  afterEach(() => vi.useRealTimers())

  it('轮询到结束只提示一次，重复盯同一个下载不重复轮询', async () => {
    vi.useFakeTimers()
    const states = [job({ state: 'running', written: 5 }), job({})]
    const poll = vi.fn(async () => states.shift() ?? job({}))
    const notify = vi.fn()
    watchDownload('d1', poll, notify)
    watchDownload('d1', poll, notify)
    await vi.advanceTimersByTimeAsync(1000)
    expect(notify).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(poll).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0].state).toBe('done')
  })
})
