import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TERMINAL_PROFILE,
  getDefaultTerminalProfile,
  getTerminalProfile,
  loadTerminalProfileSettings,
  saveTerminalProfileSettings,
  TERMINAL_PROFILES_KEY,
} from '@/lib/terminal/terminalProfiles'
import { availableTerminalShells, defaultTerminalShell } from '@/lib/terminal/terminalShell'

describe('terminalProfiles defaultShell', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    })
    localStorage.removeItem(TERMINAL_PROFILES_KEY)
  })

  it('loads platform default shell when unset', () => {
    const settings = loadTerminalProfileSettings()
    expect(settings.defaultShell).toBe(defaultTerminalShell())
    expect(getDefaultTerminalProfile().shell).toBe(settings.defaultShell)
  })

  it('applies global defaultShell to the built-in profile', () => {
    const shells = availableTerminalShells()
    const globalShell = shells.find(id => id !== defaultTerminalShell()) ?? shells[0]
    saveTerminalProfileSettings({
      defaultProfileId: null,
      defaultShell: globalShell,
      profiles: [{ ...DEFAULT_TERMINAL_PROFILE, shell: defaultTerminalShell() }],
    })
    expect(loadTerminalProfileSettings().defaultShell).toBe(globalShell)
    expect(getTerminalProfile('default').shell).toBe(globalShell)
    expect(getDefaultTerminalProfile().shell).toBe(globalShell)
  })

  it('keeps custom profile shells independent of the global default', () => {
    const shells = availableTerminalShells()
    const globalShell = shells[0]
    const customShell = shells[Math.min(1, shells.length - 1)]
    saveTerminalProfileSettings({
      defaultProfileId: 'custom',
      defaultShell: globalShell,
      profiles: [
        { ...DEFAULT_TERMINAL_PROFILE, shell: globalShell },
        {
          id: 'custom',
          name: 'OpenCode',
          command: 'opencode',
          shell: customShell,
        },
      ],
    })
    expect(getTerminalProfile('custom').shell).toBe(customShell)
    expect(getTerminalProfile('default').shell).toBe(globalShell)
  })
})
