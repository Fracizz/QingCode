import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import { cancelSshOpening, runSshOpening, SshPreparationError, useSshOpeningStore } from './sshOpeningStore'

const project: Project = { id: 'remote', name: 'app', path: 'ssh://c/home/app', kind: 'ssh', created_at: 1, last_opened_at: 1 }

afterEach(() => {
  cancelSshOpening()
  vi.useRealTimers()
})

describe('SSH opening deadline', () => {
  it('accumulates stage time without resetting on status polls or shared-service hints', async () => {
    vi.useFakeTimers()
    let progress!: Parameters<Parameters<typeof runSshOpening>[1]>[1]
    const opening = runSshOpening(project, async (_signal, report) => {
      progress = report
      return new Promise(() => {})
    }).catch(error => error)
    await vi.advanceTimersByTimeAsync(2000)
    progress('mounting')
    const serviceStart = useSshOpeningStore.getState().attempt?.stageStartedAt
    await vi.advanceTimersByTimeAsync(3000)
    progress('service')
    expect(useSshOpeningStore.getState().attempt?.stageStartedAt).toBe(serviceStart)
    progress('files')
    expect(useSshOpeningStore.getState().attempt?.stageDurations).toEqual({ connecting: 2000, service: 3000 })
    cancelSshOpening()
    await opening
  })

  it('bounds even a hung native request and ignores its late progress', async () => {
    vi.useFakeTimers()
    let reportLate!: () => void
    const opening = runSshOpening(project, async (_signal, report) => {
      reportLate = () => report('files')
      return new Promise(() => {})
    }, 100)
    const rejected = expect(opening).rejects.toBeInstanceOf(SshPreparationError)
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(useSshOpeningStore.getState().attempt?.error).toContain('超时')
    reportLate()
    expect(useSshOpeningStore.getState().attempt?.stage).toBe('connecting')
    expect(vi.getTimerCount()).toBe(0)
  })
})
