/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import {
  explorerPathForCopyShortcut,
  explorerPathsForCopyShortcut,
  getExplorerSelectedPath,
  getExplorerSelectedPaths,
  setExplorerSelectedPath,
  setExplorerSelectedPaths,
} from './explorerSelection'

describe('explorerSelection', () => {
  afterEach(() => {
    setExplorerSelectedPaths([])
    document.body.innerHTML = ''
  })

  it('stores the explorer selection path', () => {
    setExplorerSelectedPath('D:/proj/a.ts')
    expect(getExplorerSelectedPath()).toBe('D:/proj/a.ts')
    expect(getExplorerSelectedPaths()).toEqual(['D:/proj/a.ts'])
  })

  it('stores multiple explorer selection paths', () => {
    setExplorerSelectedPaths(['D:/proj/a.ts', 'D:/proj/b.ts'])
    expect(getExplorerSelectedPaths()).toEqual(['D:/proj/a.ts', 'D:/proj/b.ts'])
    expect(getExplorerSelectedPath()).toBe('D:/proj/a.ts')
  })

  it('returns explorer paths for copy only when explorer is focused', () => {
    setExplorerSelectedPaths(['D:/proj/src', 'D:/proj/assets'])
    expect(explorerPathsForCopyShortcut()).toEqual([])
    expect(explorerPathForCopyShortcut()).toBeNull()

    const shell = document.createElement('div')
    shell.setAttribute('data-qingcode-explorer', '')
    const inner = document.createElement('button')
    shell.appendChild(inner)
    document.body.appendChild(shell)
    inner.focus()

    expect(explorerPathsForCopyShortcut()).toEqual(['D:/proj/src', 'D:/proj/assets'])
    expect(explorerPathForCopyShortcut()).toBe('D:/proj/src')
  })
})
