import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWatcherTreeRefreshQueue } from './watcherTreeRefreshQueue'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('watcher tree refresh queue', () => {
  it('keeps changes from more than four directories and coalesces duplicate paths', async () => {
    const refresh = vi.fn(async () => {})
    const queue = createWatcherTreeRefreshQueue(refresh, vi.fn())
    const paths = Array.from({ length: 8 }, (_, i) => `D:/project/dir${i}/new.txt`)
    paths.forEach(path => queue.enqueue(path))
    queue.enqueue('d:\\project\\dir0\\new.txt')
    await vi.advanceTimersByTimeAsync(500)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0][0]).toHaveLength(8)
    expect(refresh.mock.calls[0][0]).toContain(paths[7])
    queue.dispose()
  })

  it('refreshes during continuous filesystem events', async () => {
    const refresh = vi.fn(async () => {})
    const queue = createWatcherTreeRefreshQueue(refresh, vi.fn())
    for (let i = 0; i < 10; i++) {
      queue.enqueue(`D:/project/file${i}.txt`)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh.mock.calls.flatMap(call => call[0])).toHaveLength(10)
    queue.dispose()
  })

  it('retains events arriving during a scan and runs them after it completes', async () => {
    let finish!: () => void
    const refresh = vi.fn<(paths: string[]) => Promise<void>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue(undefined)
    const queue = createWatcherTreeRefreshQueue(refresh, vi.fn())
    queue.enqueue('D:/project/first.txt')
    await vi.advanceTimersByTimeAsync(500)
    queue.enqueue('D:/project/later.txt')
    await vi.advanceTimersByTimeAsync(2000)
    expect(refresh).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(refresh).toHaveBeenNthCalledWith(2, ['D:/project/later.txt'])
    queue.dispose()
  })

  it('continues after a failed scan and stops after disposal', async () => {
    const error = new Error('scan failed')
    const onError = vi.fn()
    const refresh = vi.fn<(paths: string[]) => Promise<void>>()
      .mockRejectedValueOnce(error).mockResolvedValue(undefined)
    const queue = createWatcherTreeRefreshQueue(refresh, onError)
    queue.enqueue('D:/project/first.txt')
    await vi.advanceTimersByTimeAsync(500)
    expect(onError).toHaveBeenCalledWith(error)
    queue.enqueue('D:/project/retry.txt')
    await vi.advanceTimersByTimeAsync(500)
    expect(refresh).toHaveBeenCalledTimes(2)
    queue.enqueue('D:/project/cancelled.txt')
    queue.dispose()
    queue.enqueue('D:/project/ignored.txt')
    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
