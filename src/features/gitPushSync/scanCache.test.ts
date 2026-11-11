// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/types'

const a = { id: 'a', path: 'C:/a' } as Project
const b = { id: 'b', path: 'ssh://c/b' } as Project

describe('scanCache', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('restores the last scan after an app restart', async () => {
    const first = await import('./scanCache')
    first.writeScanCache([a, b], {
      a: { repo: 'host/team/app', branch: 'main' },
      b: { repo: null, branch: null },
    })
    vi.resetModules()
    const reloaded = await import('./scanCache')
    expect(reloaded.readScanCache([a, b])).toEqual({
      a: { repo: 'host/team/app', branch: 'main' },
      b: { repo: null, branch: null },
    })
  })

  it('drops projects that are no longer listed and ignores corrupt storage', async () => {
    const cache = await import('./scanCache')
    cache.writeScanCache([a, b], { a: { repo: 'r', branch: 'x' }, b: { repo: 'r', branch: 'y' } })
    cache.writeScanCache([a], { a: { repo: 'r', branch: 'x' } })
    expect(Object.keys(JSON.parse(localStorage.getItem('qingcode.gitPushSync.scanCache') ?? '{}'))).toHaveLength(1)

    localStorage.setItem('qingcode.gitPushSync.scanCache', '{bad')
    vi.resetModules()
    const reloaded = await import('./scanCache')
    expect(reloaded.readScanCache([a])).toEqual({})
  })
})
