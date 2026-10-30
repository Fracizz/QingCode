import { describe, expect, it, vi } from 'vitest'
import { createFileWatchSync } from './fileWatchSync'

const target = (path: string) => ({ roots: [path], files: [] })

describe('native file watch synchronization', () => {
  it('bounds a stalled native call to one in-flight request and the latest watch set', async () => {
    let finish!: () => void
    const apply = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => {
      finish = resolve
    })).mockResolvedValue(undefined)
    const sync = createFileWatchSync(apply, vi.fn())
    sync.request(target('initial'))
    for (let i = 0; i < 1000; i++) sync.request(target(`project-${i}`))
    expect(apply).toHaveBeenCalledTimes(1)
    finish()
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2))
    expect(apply).toHaveBeenLastCalledWith(target('project-999'))
  })

  it('skips applied targets and still allows an explicit focus recovery', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    const sync = createFileWatchSync(apply, vi.fn())
    sync.request(target('project'))
    await Promise.resolve()
    sync.request(target('project'))
    expect(apply).toHaveBeenCalledTimes(1)
    sync.request(target('project'), true)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('allows retrying a failed target without a background retry loop', async () => {
    const error = new Error('watch unavailable')
    const apply = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
    const onError = vi.fn()
    const sync = createFileWatchSync(apply, onError)
    sync.request(target('project'))
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(error)
    expect(apply).toHaveBeenCalledTimes(1)
    sync.request(target('project'))
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('drops queued work when the window hook unmounts', async () => {
    let finish!: () => void
    const apply = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const sync = createFileWatchSync(apply, vi.fn())
    sync.request(target('initial'))
    sync.request(target('queued'))
    sync.dispose()
    finish()
    await Promise.resolve()
    sync.request(target('after-unmount'))
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
