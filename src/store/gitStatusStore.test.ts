/** @vitest-environment jsdom */
import { describe, expect, it, beforeEach } from 'vitest'
import { useGitStatusStore } from './gitStatusStore'
import type { GitStatus } from '@/lib/git/git'

const sample: GitStatus = {
  is_repository: true,
  branch: 'main',
  changes: [
    { path: 'a.ts', status: ' M' },
    { path: 'b.ts', status: '??' },
  ],
}

describe('gitStatusStore panel snapshot', () => {
  beforeEach(() => {
    useGitStatusStore.getState().clear()
  })

  it('stores and peeks status by project path', () => {
    useGitStatusStore.getState().setPanelStatus('D:\\repo', sample)
    expect(useGitStatusStore.getState().peekPanelStatus('D:\\repo')).toEqual(sample)
    expect(useGitStatusStore.getState().peekPanelStatus('D:\\other')).toBeNull()
  })

  it('clearPanelStatus removes only matching path when specified', () => {
    useGitStatusStore.getState().setPanelStatus('D:\\repo', sample)
    useGitStatusStore.getState().clearPanelStatus('D:\\other')
    expect(useGitStatusStore.getState().peekPanelStatus('D:\\repo')).toEqual(sample)
    useGitStatusStore.getState().clearPanelStatus('D:\\repo')
    expect(useGitStatusStore.getState().peekPanelStatus('D:\\repo')).toBeNull()
  })

  it('applyFromGitStatus seeds badge and panel state without a second fetch', () => {
    useGitStatusStore.getState().applyFromGitStatus('D:\\repo', sample)
    expect(useGitStatusStore.getState().dirtyCount).toBe(2)
    expect(useGitStatusStore.getState().statusFor('D:\\repo\\a.ts')).toBe(' M')
    expect(useGitStatusStore.getState().panelStatus).toEqual(sample)
    expect(useGitStatusStore.getState().peekPanelStatus('D:\\repo')?.changes).toEqual([
      { path: 'a.ts', status: ' M' },
      { path: 'b.ts', status: '??' },
    ])
  })

  it('applyFromGitStatus notifies project-tab badges of the dirty count', () => {
    const seen: number[] = []
    const onCount = (event: Event) => {
      seen.push((event as CustomEvent<{ dirtyCount: number }>).detail.dirtyCount)
    }
    window.addEventListener('qingcode:git-dirty-count', onCount)
    useGitStatusStore.getState().applyFromGitStatus('D:\\repo', sample)
    useGitStatusStore.getState().applyFromGitStatus('D:\\repo', {
      ...sample,
      changes: [],
    })
    window.removeEventListener('qingcode:git-dirty-count', onCount)
    expect(seen).toEqual([2, 0])
  })
})
