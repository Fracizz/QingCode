import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleInput, ScheduleRun, ScheduleSummary } from '@qn/protocol'
import type { ScheduledExecution } from './runner'
import { ScheduleService } from './service'

const START = '2026-11-27T08:59:45Z'
const DAY = 86_400_000

describe('目标机定时任务', () => {
  let cwd: string
  let service: ScheduleService
  let input: ScheduleInput
  let running: ScheduledExecution | undefined
  const start = vi.fn((task: ScheduledExecution) => { running = task })
  const stop = vi.fn((ids?: ReadonlySet<string>) => {
    if (running && ids?.has(running.taskId)) {
      running.update({ status: 'interrupted' })
      running = undefined
    }
  })
  const runner = { get busy() { return !!running }, start, stop }
  const create = (patch?: Partial<ScheduleInput>) =>
    service.request('schedule.upsert', { ...input, ...patch }) as ScheduleSummary
  const list = () => service.request('schedule.list', { cwd }) as ScheduleSummary[]
  const history = (id: string) => service.request('schedule.runs', { cwd, id }) as ScheduleRun[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(START))
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-schedule-'))
    input = {
      cwd, name: 'Daily report', prompt: 'Summarize changes', agent: 'codex', enabled: true,
      cadence: { frequency: 'daily', time: '09:00', timeZone: 'UTC' },
    }
    running = undefined
    start.mockClear()
    stop.mockClear()
    service = new ScheduleService(cwd, runner, vi.fn(), vi.fn())
  })

  afterEach(() => {
    service.stop()
    vi.useRealTimers()
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('先持久化记录和下一次触发，忙时跳过重叠任务', async () => {
    const first = create()
    const second = create({ name: 'Second' })
    const at = first.nextRunAt!
    expect(service.keepAlive).toBe(true)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(start).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(fs.readFileSync(path.join(cwd, 'schedules.json'), 'utf8'))
    expect(stored.tasks[0]).toMatchObject({
      nextRunAt: at + DAY, runs: [{ agent: 'codex', status: 'running', scheduledAt: at }],
    })
    expect(history(second.id)).toMatchObject([{ status: 'skipped', reason: 'busy' }])
    expect(() => service.request('schedule.runNow', { cwd, id: second.id })).toThrow()
    running!.update({ threadId: 'thread-one', status: 'waiting' })
    expect(history(first.id)[0]).toMatchObject({ status: 'waiting', threadId: 'thread-one' })
    running!.update({ status: 'succeeded' })
    expect(history(first.id)[0]).toMatchObject({ status: 'succeeded', threadId: 'thread-one' })
  })

  it('重启后收尾未完成的运行，跳过停机期间的触发', async () => {
    const task = create()
    await vi.advanceTimersByTimeAsync(15_000)
    const before = history(task.id)[0]!.id
    service.stop()
    running = undefined
    vi.setSystemTime(new Date('2026-11-28T10:00:00Z'))
    service = new ScheduleService(cwd, runner, vi.fn(), vi.fn())

    expect(start).toHaveBeenCalledTimes(1)
    expect(history(task.id)).toMatchObject([
      { status: 'missed' }, { id: before, status: 'interrupted', reason: 'daemonRestarted' },
    ])
    expect(list()[0]!.nextRunAt).toBe(Date.parse('2026-11-29T09:00:00Z'))
  })

  it('要求确认 pi 权限，立即运行不改变周期，取消项目信任时中断本项目任务', () => {
    expect(() => create({ agent: 'pi' })).toThrow()
    const task = create({ agent: 'pi', piAcknowledged: true })
    service.request('schedule.runNow', { cwd, id: task.id })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ agent: 'pi' }))
    expect(list()[0]!.nextRunAt).toBe(task.nextRunAt)
    expect(service.request('schedule.pauseProject', { cwd })).toEqual({ paused: 1 })
    expect(history(task.id)).toMatchObject([{ status: 'interrupted', scheduledAt: null }])
    expect(service.keepAlive).toBe(false)
  })

  it('限额暂停同一 Agent 的任务，保留其他 Agent 的计划', () => {
    const task = create()
    const codex = create({ name: 'Another Codex task' })
    const claude = create({ agent: 'claude' })
    service.request('schedule.runNow', { cwd, id: task.id })
    const resetAt = Date.parse('2026-11-27T12:00:00Z')
    running!.update({ status: 'rateLimited' }, resetAt)
    expect(list().find(({ id }) => id === codex.id)).toMatchObject({
      rateLimitedUntil: resetAt, nextRunAt: Date.parse('2026-11-28T09:00:00Z'),
    })
    expect(list().find(({ id }) => id === claude.id)?.nextRunAt).toBe(claude.nextRunAt)
  })
  it('缺少重置时间时停用计划，明确重新启用前拒绝立即运行', () => {
    const first = create()
    const second = create({ name: 'Second' })
    service.request('schedule.runNow', { cwd, id: first.id })
    running!.update({ status: 'rateLimited' })
    running = undefined
    expect(list()).toMatchObject([
      { enabled: false, requiresManualResume: true }, { enabled: false, requiresManualResume: true },
    ])
    expect(() => service.request('schedule.runNow', { cwd, id: second.id })).toThrow('额度尚未恢复')
    service.request('schedule.setEnabled', { cwd, id: first.id, enabled: true })
    expect(list()).toMatchObject([
      { enabled: true, requiresManualResume: false }, { enabled: false, requiresManualResume: false },
    ])
  })

})
