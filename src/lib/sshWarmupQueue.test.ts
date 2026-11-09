import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, SshConnection } from '../types'
import {
  selectWarmupTargets,
  SshWarmupQueue,
  SSH_WARMUP_CONCURRENCY,
  SSH_WARMUP_CONNECTION_CONCURRENCY,
  SSH_WARMUP_CONNECTION_LIMIT,
  SSH_WARMUP_DELAY_MS,
  SSH_WARMUP_RECOVERY_DELAY_MS,
  SSH_WARMUP_RETRY_DELAYS_MS,
  type WarmupStatus,
  type WarmupTarget,
} from './sshWarmupQueue'

function target(index: number, connectionId = 'host'): WarmupTarget {
  const project: Project = {
    id: String(index),
    name: String(index),
    path: `ssh://${connectionId}/p${index}`,
    last_opened_at: index,
    created_at: 0,
  }
  return { project, connectionId, version: project.path }
}
function connection(id: string): SshConnection {
  return {
    id,
    name: id,
    host: id,
    port: 22,
    username: 'test',
    auth_kind: 'privateKey',
    host_key_fingerprint: 'SHA256:test',
    mode: 'server',
    created_at: 0,
    updated_at: 0,
  }
}
const queues: Array<SshWarmupQueue<number[]>> = []
function harness(run = vi.fn(async () => [1])) {
  let statuses: ReadonlyMap<string, WarmupStatus> = new Map()
  const queue = new SshWarmupQueue<number[]>({
    run,
    weight: result => result.length,
    changed: next => {
      statuses = next
    },
  })
  queues.push(queue)
  return { queue, run, statuses: () => statuses }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const queue of queues.splice(0)) queue.dispose()
  vi.useRealTimers()
})

describe('bounded SSH background preparation', () => {
  it('keeps foreground-opened roots ready across repeated switches without running warmup again', async () => {
    const { queue, run, statuses } = harness()
    const targets = [target(1), target(2)]
    queue.update(targets, targets[0].project.path)
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(targets[1], expect.any(AbortSignal))

    for (let i = 0; i < 4; i++) {
      queue.update(targets, targets[i % 2].project.path)
      await vi.runAllTimersAsync()
      expect([...statuses().values()].map(status => status.phase)).toEqual(['ready', 'ready'])
    }
    expect(run).toHaveBeenCalledTimes(1)
    // Foreground activation releases the pre-open directory snapshot.
    expect(queue.take(targets[1].project.path)).toBeUndefined()
    expect(statuses().get(targets[1].project.path)?.phase).toBe('ready')
  })

  it('does not revive an invalidated active root on an ordinary list refresh', async () => {
    const { queue, run, statuses } = harness()
    const targets = [target(1)]
    const path = targets[0].project.path
    queue.update(targets, path)
    queue.invalidateConnection('host')
    queue.update(targets, path)
    await vi.runAllTimersAsync()
    expect(statuses().has(path)).toBe(false)
    expect(run).not.toHaveBeenCalled()
    queue.update(targets)
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(1)
    expect(statuses().get(path)?.phase).toBe('ready')
  })

  it('selects the most recent eligible roots from 100,000 projects without per-project IPC or timers', () => {
    const projects = Array.from({ length: 100_000 }, (_, i) => target(i).project)
    projects[99_999].hidden = 1
    const selected = selectWarmupTargets(
      projects,
      [connection('host')],
      project => project.id !== '99998'
    )
    expect(selected).toHaveLength(12)
    expect(selected[0].project.id).toBe('99997')
    const { queue, run, statuses } = harness()
    queue.update(selected)
    expect(statuses().size).toBe(12)
    expect(vi.getTimerCount()).toBe(1)
    expect(run).not.toHaveBeenCalled()
  })

  it('bounds both project and connection attempts for the entire session even after list churn', async () => {
    const { queue, run } = harness()
    queue.update(Array.from({ length: 12 }, (_, i) => target(i)))
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(12)
    queue.update(Array.from({ length: 50 }, (_, i) => target(i + 12)))
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(12)
    const hosts = harness()
    hosts.queue.update(Array.from({ length: 50 }, (_, i) => target(i, `host${i}`)))
    await vi.runAllTimersAsync()
    expect(hosts.run).toHaveBeenCalledTimes(SSH_WARMUP_CONNECTION_LIMIT)
  })

  it('warms different connections concurrently, one unproven root per connection, up to the cap', async () => {
    const finish: Array<() => void> = []
    const started: string[] = []
    const run = vi.fn((value: WarmupTarget) => new Promise<number[]>(resolve => {
      started.push(value.project.path)
      finish.push(() => resolve([1]))
    }))
    const { queue } = harness(run)
    const count = SSH_WARMUP_CONCURRENCY + 1
    const targets = Array.from({ length: count }, (_, i) => target(i, `host${i}`))
    queue.update([target(100, 'host0'), ...targets])
    await vi.advanceTimersByTimeAsync(SSH_WARMUP_DELAY_MS)
    expect(run).toHaveBeenCalledTimes(SSH_WARMUP_CONCURRENCY)
    expect(started).toEqual([
      target(100, 'host0').project.path,
      ...targets.slice(1, SSH_WARMUP_CONCURRENCY).map(item => item.project.path),
    ])
    // 空出的名额不再等待延迟；host0 的下一个项目可以接续。
    finish[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(SSH_WARMUP_CONCURRENCY + 1)
    expect(started.at(-1)).toBe(targets[0].project.path)
  })

  it('joins an in-flight task and starts no other background task while foreground is active', async () => {
    let finish!: (value: number[]) => void
    const run = vi.fn(
      () =>
        new Promise<number[]>(resolve => {
          finish = resolve
        })
    )
    const { queue } = harness(run)
    queue.update([target(1), target(2)])
    await vi.advanceTimersByTimeAsync(SSH_WARMUP_DELAY_MS)
    const end = queue.beginForeground()
    const joined = queue.take(target(1).project.path)
    expect(joined).toBeDefined()
    finish([42])
    expect(await joined).toEqual([42])
    await vi.advanceTimersByTimeAsync(100_000)
    expect(run).toHaveBeenCalledTimes(1)
    end()
    await vi.advanceTimersByTimeAsync(SSH_WARMUP_DELAY_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not launch a queued clicked project in the background', async () => {
    const { queue, run } = harness()
    queue.update([target(1)])
    expect(queue.take(target(1).project.path)).toBeUndefined()
    await vi.runAllTimersAsync()
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps the real slot occupied after hiding or disconnecting until native work settles', async () => {
    let finish!: (value: number[]) => void
    const run = vi.fn(
      () =>
        new Promise<number[]>(resolve => {
          finish = resolve
        })
    )
    const { queue, statuses } = harness(run)
    queue.update([target(1, 'a')])
    await vi.advanceTimersByTimeAsync(SSH_WARMUP_DELAY_MS)
    queue.invalidateConnection('a')
    queue.update([target(2, 'a')])
    await vi.advanceTimersByTimeAsync(100_000)
    expect(run).toHaveBeenCalledTimes(1)
    finish([99])
    await vi.advanceTimersByTimeAsync(SSH_WARMUP_DELAY_MS)
    expect(run).toHaveBeenCalledTimes(2)
    expect(statuses().has(target(1, 'a').project.path)).toBe(false)
  })

  it('preserves the failure and skips other roots of that host while continuing other hosts', async () => {
    const run = vi.fn(async (value: WarmupTarget) => {
      if (value.connectionId === 'a') throw new Error('SSH 密码未保存在本机')
      return [1]
    })
    const { queue, statuses } = harness(run)
    queue.update([target(1, 'a'), target(2, 'a'), target(3, 'b')])
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(2)
    expect(statuses().get(target(1, 'a').project.path)?.phase).toBe('attention')
    expect(statuses().get(target(2, 'a').project.path)?.phase).toBe('attention')
    expect(statuses().get(target(3, 'b').project.path)?.phase).toBe('ready')
  })

  it('does not retain oversized results or exceed the aggregate directory cache budget', async () => {
    const { queue } = harness(vi.fn(async () => Array(256).fill(1) as number[]))
    queue.update(Array.from({ length: 12 }, (_, i) => target(i)))
    await vi.runAllTimersAsync()
    await expect(queue.take(target(7).project.path)).resolves.toHaveLength(256)
    // 目录超预算没留下，但服务已准备好，取到的是“已准备、无目录”。
    await expect(queue.take(target(8).project.path)).resolves.toBeUndefined()
    const big = harness(vi.fn(async () => Array(257).fill(1) as number[]))
    big.queue.update([target(1)])
    await vi.runAllTimersAsync()
    await expect(big.queue.take(target(1).project.path)).resolves.toBeUndefined()
  })

  it('runs the first root of a connection alone, then fans out once it succeeded', async () => {
    const finish: Array<() => void> = []
    const run = vi.fn(() => new Promise<number[]>(resolve => finish.push(() => resolve([1]))))
    const { queue } = harness(run)
    queue.update(Array.from({ length: 6 }, (_, i) => target(i, 'a')))
    await vi.advanceTimersByTimeAsync(SSH_WARMUP_DELAY_MS)
    expect(run).toHaveBeenCalledTimes(1)
    finish[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1 + SSH_WARMUP_CONNECTION_CONCURRENCY)
  })

  it('retries a failed connection with one attempt per round and stops at the budget', async () => {
    const run = vi.fn(async (): Promise<number[]> => {
      throw new Error('network unreachable')
    })
    const { queue, statuses } = harness(run)
    queue.update([target(1, 'a'), target(2, 'a'), target(3, 'a')])
    await vi.advanceTimersByTimeAsync(SSH_WARMUP_DELAY_MS)
    expect(run).toHaveBeenCalledTimes(1)
    expect(statuses().get(target(3, 'a').project.path)?.phase).toBe('failed')
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(1 + SSH_WARMUP_RETRY_DELAYS_MS.length)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tries another root on retry so one stale project cannot block its connection', async () => {
    const run = vi.fn(async (value: WarmupTarget) => {
      if (value.project.id === '1') throw new Error('目录不存在')
      return [1]
    })
    const { queue, statuses } = harness(run)
    queue.update([target(1, 'a'), target(2, 'a')])
    await vi.runAllTimersAsync()
    expect(statuses().get(target(2, 'a').project.path)?.phase).toBe('ready')
    expect(statuses().get(target(1, 'a').project.path)?.phase).toBe('failed')
  })

  it('never retries failures that need the user', async () => {
    const run = vi.fn(async (): Promise<number[]> => {
      throw new Error('SSH authentication failed')
    })
    const { queue } = harness(run)
    queue.update([target(1)])
    await vi.runAllTimersAsync()
    queue.retryFailed()
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('warms again after an unexpected disconnect but leaves the active root until reopened', async () => {
    const { queue, run, statuses } = harness()
    const targets = [target(1, 'a'), target(2, 'a')]
    queue.update(targets, targets[0].project.path)
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(1)
    queue.connectionLost('a')
    expect(statuses().has(targets[0].project.path)).toBe(false)
    expect(statuses().get(targets[1].project.path)?.phase).toBe('queued')
    await vi.advanceTimersByTimeAsync(SSH_WARMUP_RECOVERY_DELAY_MS - 1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(2)
    expect(statuses().get(targets[1].project.path)?.phase).toBe('ready')
  })

  it('retries exhausted failures right after a server update', async () => {
    let healthy = false
    const run = vi.fn(async (): Promise<number[]> => {
      if (!healthy) throw new Error('gateway restarting')
      return [1]
    })
    const { queue, statuses } = harness(run)
    queue.update([target(1)])
    await vi.runAllTimersAsync()
    expect(statuses().get(target(1).project.path)?.phase).toBe('failed')
    healthy = true
    queue.retryFailed()
    await vi.runAllTimersAsync()
    expect(statuses().get(target(1).project.path)?.phase).toBe('ready')
  })

  it('pauses the queue when the window is hidden and invalidates changed configurations', async () => {
    const { queue, run, statuses } = harness()
    queue.setPaused(true)
    queue.update([target(1)])
    await vi.advanceTimersByTimeAsync(100_000)
    expect(run).not.toHaveBeenCalled()
    queue.setPaused(false)
    await vi.runAllTimersAsync()
    expect(statuses().get(target(1).project.path)?.phase).toBe('ready')
    queue.update([{ ...target(1), version: 'new host fingerprint' }])
    expect(statuses().get(target(1).project.path)?.phase).toBe('queued')
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(2)
    queue.update([])
    expect(statuses().size).toBe(0)
  })
})
