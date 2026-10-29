import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadGlobalSettings, loadProjectSettings } from './projectSettings'
import { loadTransferConcurrency, parseTransferConcurrency } from './transferSettings'
import type { Project } from '../types'

vi.mock('./projectSettings', () => ({ loadGlobalSettings: vi.fn(), loadProjectSettings: vi.fn() }))

beforeEach(() => vi.resetAllMocks())

describe('transfer concurrency', () => {
  it('defaults invalid values and bounds the number of workers', () => {
    for (const value of [undefined, null, '8', NaN, Infinity]) expect(parseTransferConcurrency(value)).toBe(4)
    expect(parseTransferConcurrency(0)).toBe(1)
    expect(parseTransferConcurrency(3.8)).toBe(3)
    expect(parseTransferConcurrency(100)).toBe(8)
  })

  it('inherits global settings and accepts workspace overrides', async () => {
    vi.mocked(loadGlobalSettings).mockResolvedValue({ version: 1, custom: {}, 'ssh.transfer.concurrency': 6 })
    const project = { id: 'remote', path: 'ssh://c/project' } as Project
    vi.mocked(loadProjectSettings).mockResolvedValueOnce({ version: 1, custom: {} })
    expect(await loadTransferConcurrency(project)).toBe(6)
    vi.mocked(loadProjectSettings).mockResolvedValueOnce({ version: 1, custom: {}, 'ssh.transfer.concurrency': 2 })
    expect(await loadTransferConcurrency(project)).toBe(2)
    expect(loadProjectSettings).toHaveBeenCalledWith(project)
  })
})
