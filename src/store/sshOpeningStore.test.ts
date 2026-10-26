import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import { cancelSshOpening, runSshOpening, SshPreparationError, useSshOpeningStore } from './sshOpeningStore'

const project: Project = { id: 'remote', name: 'app', path: 'ssh://c/home/app', kind: 'ssh', created_at: 1, last_opened_at: 1 }

afterEach(() => {
  cancelSshOpening()
  vi.useRealTimers()
})

describe('SSH opening deadline', () => {
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
