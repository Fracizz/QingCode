import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TERMINAL_PROFILE,
  LOCAL_PROFILE_SCOPE,
  copyProfileToScope,
  profilesForConnection,
  getDefaultTerminalProfile,
  getPrewarmShell,
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

  it.each([
    ['pwsh', 'claude', 'pwsh'],
    ['cmd', '', 'cmd'],
    ['cmd', 'tool', 'powershell'],
    ['wsl', '', 'powershell'],
  ])('selects the prewarm shell for a default %s profile with command %j', (shell, command, expected) => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    try {
      localStorage.setItem(TERMINAL_PROFILES_KEY, JSON.stringify({
        defaultProfileId: 'custom', defaultShell: 'powershell',
        profiles: [{ id: 'custom', name: 'Custom', shell, command }],
      }))
      expect(getPrewarmShell()).toBe(expected)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('filters profiles by connection scope and falls back when the global default belongs elsewhere', async () => {
    const { effectiveDefaultProfileIdFor, saveConnectionDefaultProfileId } = await import('./connectionDefaultProfile')
    vi.stubGlobal('window', { dispatchEvent: () => true })
    try {
      saveTerminalProfileSettings({
        defaultProfileId: 'win',
        defaultShell: defaultTerminalShell(),
        profiles: [
          { ...DEFAULT_TERMINAL_PROFILE },
          { id: 'common', name: 'Common', command: '', shell: 'auto' },
          { id: 'here', name: 'Here', command: '', shell: 'auto', scope: LOCAL_PROFILE_SCOPE },
          { id: 'win', name: 'Win', command: '', shell: 'auto', scope: 'win-dev' },
        ],
      })
      const settings = loadTerminalProfileSettings()
      expect(profilesForConnection(settings, 'win-dev').map(p => p.id)).toEqual(['default', 'common', 'win'])
      expect(profilesForConnection(settings, null).map(p => p.id)).toEqual(['default', 'common', 'here'])
      expect(effectiveDefaultProfileIdFor('win-dev', settings)).toBe('win')
      expect(effectiveDefaultProfileIdFor(null, settings)).toBe('default')
      expect(effectiveDefaultProfileIdFor('other', settings)).toBe('default')
      // 连接默认指向其他分类的配置时失效。
      saveConnectionDefaultProfileId('other', 'here')
      expect(effectiveDefaultProfileIdFor('other', settings)).toBe('default')
      saveConnectionDefaultProfileId('other', 'common')
      expect(effectiveDefaultProfileIdFor('other', settings)).toBe('common')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('copies a profile into another scope with a new id', () => {
    const copy = copyProfileToScope({ name: 'Claude', command: 'claude', shell: 'pwsh' }, 'win-dev')
    expect(copy).toMatchObject({ name: 'Claude', command: 'claude', shell: 'pwsh', scope: 'win-dev' })
    expect(copy.id).not.toBe('')
    expect('scope' in copyProfileToScope(copy, undefined)).toBe(false)
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
