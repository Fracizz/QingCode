// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

describe('shortcutStore migration', () => {
  it('merges the default open-file shortcut into older saved settings', async () => {
    localStorage.setItem(
      'qingcode:shortcuts',
      JSON.stringify({
        quickOpen: 'Alt+P',
      })
    )

    const { useShortcutStore } = await import('./shortcutStore')

    expect(useShortcutStore.getState().shortcuts).toMatchObject({
      openFile: 'Ctrl+O',
      quickOpen: 'Alt+P',
    })
  })
})
