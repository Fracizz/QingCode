import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  resolveGlobalSettingsPath,
  settingsFileExists,
  parseSettingsText,
  saveGlobalSettings,
  safeInvoke,
} = vi.hoisted(() => ({
  resolveGlobalSettingsPath: vi.fn(async () => 'D:/settings/default-settings.json'),
  settingsFileExists: vi.fn(async () => true),
  parseSettingsText: vi.fn((_raw: string) => ({ 'editor.minimap.enabled': false })),
  saveGlobalSettings: vi.fn(async () => undefined),
  safeInvoke: vi.fn(async () => '// 不计划\n"editor.minimap.enabled": false'),
}))

vi.mock('./projectSettings', async () => {
  const actual = await vi.importActual<typeof import('./projectSettings')>('./projectSettings')
  return {
    ...actual,
    resolveGlobalSettingsPath,
    settingsFileExists,
    parseSettingsText,
    saveGlobalSettings,
    DEFAULT_GLOBAL_SETTINGS: { 'editor.minimap.enabled': true },
  }
})

vi.mock('./tauri', () => ({
  safeInvoke,
}))

import {
  migrateLegacyMinimapSetting,
  parseMinimapEnabled,
  readMinimapEnabled,
} from './minimapSettings'

const LEGACY_MIGRATE_FLAG = 'qingcode:minimap-legacy-unplanned-v1'

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k)
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
  } as Storage
}

describe('minimapSettings', () => {
  it('defaults missing key to enabled', () => {
    expect(parseMinimapEnabled(undefined)).toBe(true)
    expect(parseMinimapEnabled(null)).toBe(true)
    expect(readMinimapEnabled({})).toBe(true)
  })

  it('reads boolean values', () => {
    expect(parseMinimapEnabled(true)).toBe(true)
    expect(parseMinimapEnabled(false)).toBe(false)
    expect(readMinimapEnabled({ 'editor.minimap.enabled': false })).toBe(false)
  })
})

describe('migrateLegacyMinimapSetting', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorageStub())
    resolveGlobalSettingsPath.mockClear()
    settingsFileExists.mockClear()
    parseSettingsText.mockClear()
    saveGlobalSettings.mockClear()
    safeInvoke.mockClear()
    settingsFileExists.mockResolvedValue(true)
    parseSettingsText.mockReturnValue({ 'editor.minimap.enabled': false })
    safeInvoke.mockResolvedValue('// 不计划\n"editor.minimap.enabled": false')
  })

  it('flips legacy false minimap once and sets the version flag', async () => {
    await migrateLegacyMinimapSetting()

    expect(localStorage.getItem(LEGACY_MIGRATE_FLAG)).toBe('1')
    expect(saveGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({ 'editor.minimap.enabled': true }),
    )
  })

  it('short-circuits when the version flag is already set', async () => {
    localStorage.setItem(LEGACY_MIGRATE_FLAG, '1')

    await migrateLegacyMinimapSetting()

    expect(resolveGlobalSettingsPath).not.toHaveBeenCalled()
    expect(safeInvoke).not.toHaveBeenCalled()
    expect(saveGlobalSettings).not.toHaveBeenCalled()
  })
})
