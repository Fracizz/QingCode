/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import {
  explorerPathForCopyShortcut,
  getExplorerSelectedPath,
  setExplorerSelectedPath,
} from './explorerSelection'

describe('explorerSelection', () => {
  afterEach(() => {
    setExplorerSelectedPath(null)
    document.body.innerHTML = ''
  })

  it('stores the explorer selection path', () => {
    setExplorerSelectedPath('D:/proj/a.ts')
    expect(getExplorerSelectedPath()).toBe('D:/proj/a.ts')
  })

  it('returns explorer path for copy only when explorer is focused', () => {
    setExplorerSelectedPath('D:/proj/src')
    expect(explorerPathForCopyShortcut()).toBeNull()

    const shell = document.createElement('div')
    shell.setAttribute('data-qingcode-explorer', '')
    const inner = document.createElement('button')
    shell.appendChild(inner)
    document.body.appendChild(shell)
    inner.focus()

    expect(explorerPathForCopyShortcut()).toBe('D:/proj/src')
  })
})
