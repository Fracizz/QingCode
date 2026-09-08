// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

describe('shortcutStore migration', () => {
  it('removes retired navigation bindings while preserving custom file navigation', async () => {
    localStorage.setItem(
      'qingcode:shortcuts',
      JSON.stringify({
        findCalls: 'Alt+F7',
        goToSymbolInWorkspace: 'Ctrl+T',
        goToSymbolInEditor: 'Ctrl+F12',
        navigateBack: 'Ctrl+Alt+Left',
        quickOpen: '',
      })
    )

    const { useShortcutStore } = await import('./shortcutStore')
    const shortcuts = useShortcutStore.getState().shortcuts

    expect(shortcuts).not.toHaveProperty('findCalls')
    expect(shortcuts).not.toHaveProperty('goToSymbolInWorkspace')
    expect(shortcuts).toMatchObject({
      goToSymbolInEditor: 'Ctrl+F12',
      navigateBack: 'Ctrl+Alt+Left',
      quickOpen: '',
    })
    expect(JSON.parse(localStorage.getItem('qingcode:shortcuts')!)).toEqual(shortcuts)
  })

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
