import { describe, expect, it, vi } from 'vitest'

vi.mock('../tauri', () => ({ isTauri: () => true, safeInvoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

import { listen } from '@tauri-apps/api/event'
import { createCoalescedRunner, listenMobileSessionOutput } from './mobileSessions'

/** 让已完成的 Promise 回调全部执行。 */
const flush = () => new Promise(resolve => setTimeout(resolve))

describe('createCoalescedRunner', () => {
  function deferredTask() {
    const finishers: Array<(failure?: Error) => void> = []
    const task = vi.fn(
      () => new Promise<void>((resolve, reject) => {
        finishers.push(failure => (failure ? reject(failure) : resolve()))
      }),
    )
    return { task, finishers }
  }

  it('merges triggers during a run into one follow-up run', async () => {
    const { task, finishers } = deferredTask()
    const run = createCoalescedRunner(task)
    run()
    run()
    run()
    expect(task).toHaveBeenCalledTimes(1)

    finishers[0]()
    await flush()
    expect(task).toHaveBeenCalledTimes(2)

    finishers[1]()
    await flush()
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('keeps running after a failed task', async () => {
    const { task, finishers } = deferredTask()
    const run = createCoalescedRunner(task)
    run()
    finishers[0](new Error('offline'))
    await flush()
    run()
    expect(task).toHaveBeenCalledTimes(2)
  })
})

describe('listenMobileSessionOutput', () => {
  it('only reports output of the requested session', async () => {
    const stop = vi.fn()
    vi.mocked(listen).mockResolvedValue(stop)
    const onOutput = vi.fn()

    await expect(listenMobileSessionOutput('mobile-1', onOutput)).resolves.toBe(stop)
    const handler = vi.mocked(listen).mock.calls[0][1] as (event: { payload: unknown }) => void
    expect(vi.mocked(listen).mock.calls[0][0]).toBe('mobile-session-output')

    handler({ payload: { id: 'mobile-2' } })
    expect(onOutput).not.toHaveBeenCalled()
    handler({ payload: { id: 'mobile-1' } })
    expect(onOutput).toHaveBeenCalledTimes(1)
  })
})
