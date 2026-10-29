import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, SshConnection } from '../types'
import {
  selectWarmupTargets,
  SshWarmupQueue,
  SSH_WARMUP_DELAY_MS,
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
    expect(hosts.run).toHaveBeenCalledTimes(3)
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
    queue.update([target(2, 'b')])
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
    expect(queue.take(target(7).project.path)).toBeDefined()
    expect(queue.take(target(8).project.path)).toBeUndefined()
    const big = harness(vi.fn(async () => Array(257).fill(1) as number[]))
    big.queue.update([target(1)])
    await vi.runAllTimersAsync()
    expect(big.queue.take(target(1).project.path)).toBeUndefined()
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
