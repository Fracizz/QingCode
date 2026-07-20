import { describe, expect, it, beforeEach } from 'vitest'
import {
  peekSourceControlCache,
  useSourceControlStore,
} from './sourceControlStore'
import { useGitStatusStore } from './gitStatusStore'
import type { GitStatus } from '../lib/git'

const sample: GitStatus = {
  is_repository: true,
  branch: 'main',
  changes: [
    { path: 'a.ts', status: ' M' },
    { path: 'b.ts', status: '??' },
  ],
}

describe('sourceControlStore', () => {
  beforeEach(() => {
    useSourceControlStore.getState().clearCache()
    useGitStatusStore.getState().clear()
  })

  it('stores and peeks status by project path', () => {
    useSourceControlStore.getState().setCache('D:\\repo', sample)
    expect(peekSourceControlCache('D:\\repo')).toEqual(sample)
    expect(peekSourceControlCache('D:\\other')).toBeNull()
  })

  it('clearCache removes only matching path when specified', () => {
    useSourceControlStore.getState().setCache('D:\\repo', sample)
    useSourceControlStore.getState().clearCache('D:\\other')
    expect(peekSourceControlCache('D:\\repo')).toEqual(sample)
    useSourceControlStore.getState().clearCache('D:\\repo')
    expect(peekSourceControlCache('D:\\repo')).toBeNull()
  })

  it('applyFromGitStatus seeds badge store and SCM cache without a second fetch', () => {
    useGitStatusStore.getState().applyFromGitStatus('D:\\repo', sample)
    expect(useGitStatusStore.getState().dirtyCount).toBe(2)
    expect(useGitStatusStore.getState().statusFor('D:\\repo\\a.ts')).toBe(' M')
    expect(peekSourceControlCache('D:\\repo')).toEqual(sample)
    expect(useGitStatusStore.getState().peekPanelStatus('D:\\repo')?.changes).toEqual([
      { path: 'a.ts', status: ' M' },
      { path: 'b.ts', status: '??' },
    ])
  })
})
