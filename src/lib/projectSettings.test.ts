import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  PROJECTS_KEY,
  PROJECTS_SYNC_ON_STARTUP_KEY,
  defaultSettingsFor,
  formatSettings,
  isGlobalSettingsPath,
  isSettingsJsonPath,
  parseSettings,
  parseSettingsText,
  projectSettingsPath,
  readProjectEntries,
  shouldSyncProjectsOnStartup,
  stripGlobalOnlyKeys,
  validateSettings,
} from './projectSettings'

describe('parseSettings', () => {
  it('returns defaults for non-objects', () => {
    expect(parseSettings(null, 'global')).toEqual(defaultSettingsFor('global'))
    expect(parseSettings('x', 'project')).toEqual(defaultSettingsFor('project'))
  })

  it('keeps custom object and free-form keys', () => {
    const parsed = parseSettings(
      { version: 1, custom: { a: 1 }, 'editor.fontSize': 18 },
      'global',
    )
    expect(parsed.custom).toEqual({ a: 1 })
    expect(parsed['editor.fontSize']).toBe(18)
    expect(parsed.version).toBe(1)
  })

  it('strips global-only keys in project scope', () => {
    const parsed = parseSettings(
      {
        version: 1,
        custom: {},
        [PROJECTS_KEY]: [{ path: 'D:/x' }],
        [PROJECTS_SYNC_ON_STARTUP_KEY]: false,
        'editor.tabSize': 2,
      },
      'project',
    )
    expect(parsed[PROJECTS_KEY]).toBeUndefined()
    expect(parsed[PROJECTS_SYNC_ON_STARTUP_KEY]).toBeUndefined()
    expect(parsed['editor.tabSize']).toBe(2)
  })

  it('defaults missing global project list keys', () => {
    const parsed = parseSettings({ version: 1, custom: {} }, 'global')
    expect(parsed[PROJECTS_KEY]).toEqual([])
    expect(parsed[PROJECTS_SYNC_ON_STARTUP_KEY]).toBe(true)
  })
})

describe('parseSettingsText', () => {
  it('parses JSON5 with comments', () => {
    const text = `{
      // comment
      version: 1,
      custom: {},
      "editor.fontSize": 16,
    }`
    const parsed = parseSettingsText(text, 'global')
    expect(parsed['editor.fontSize']).toBe(16)
  })

  it('falls back to defaults on invalid text', () => {
    expect(parseSettingsText('{ broken', 'project')).toEqual(DEFAULT_PROJECT_SETTINGS)
  })
})

describe('validateSettings / strip / format', () => {
  it('rejects invalid shapes', () => {
    expect(validateSettings(null)).toMatch(/对象/)
    expect(validateSettings({ version: 2, custom: {} })).toMatch(/版本/)
    expect(validateSettings({ version: 1, custom: [] })).toMatch(/custom/)
    expect(validateSettings({ version: 1, custom: {}, [PROJECTS_KEY]: {} })).toMatch(/数组/)
  })

  it('accepts a valid object', () => {
    expect(validateSettings({ version: 1, custom: {} })).toBeNull()
  })

  it('stripGlobalOnlyKeys removes project list keys', () => {
    const stripped = stripGlobalOnlyKeys({
      ...DEFAULT_GLOBAL_SETTINGS,
      [PROJECTS_KEY]: [{ path: 'D:/a' }],
      [PROJECTS_SYNC_ON_STARTUP_KEY]: false,
    })
    expect(stripped[PROJECTS_KEY]).toBeUndefined()
    expect(stripped[PROJECTS_SYNC_ON_STARTUP_KEY]).toBeUndefined()
  })

  it('formatSettings returns commented template for default shape', () => {
    const text = formatSettings(DEFAULT_GLOBAL_SETTINGS, 'global')
    expect(text).toContain('QingCode 全局设置')
    expect(text).toContain('qingcode.projects')
  })
})

describe('project entries / paths', () => {
  it('readProjectEntries normalizes and skips invalid rows', () => {
    const entries = readProjectEntries({
      version: 1,
      custom: {},
      [PROJECTS_KEY]: [
        { path: '  D:/Work/a  ', name: '  Alpha  ', hidden: true, defaultShell: ' pwsh ' },
        { path: '' },
        { name: 'no-path' },
        'skip',
      ],
    })
    expect(entries).toEqual([
      {
        path: 'D:/Work/a',
        name: 'Alpha',
        hidden: true,
        defaultShell: 'pwsh',
      },
    ])
  })

  it('shouldSyncProjectsOnStartup is true unless explicitly false', () => {
    expect(shouldSyncProjectsOnStartup({ version: 1, custom: {} })).toBe(true)
    expect(
      shouldSyncProjectsOnStartup({
        version: 1,
        custom: {},
        [PROJECTS_SYNC_ON_STARTUP_KEY]: false,
      }),
    ).toBe(false)
  })

  it('detects settings paths', () => {
    expect(isSettingsJsonPath('C:\\App\\default-settings.json')).toBe(true)
    expect(isSettingsJsonPath('D:/proj/.qingcode/project-settings.json')).toBe(true)
    expect(isGlobalSettingsPath('C:/x/default-settings.json')).toBe(true)
    expect(isGlobalSettingsPath('D:/proj/.qingcode/project-settings.json')).toBe(false)
  })

  it('builds project settings path with matching separators', () => {
    expect(projectSettingsPath({ id: '1', name: 'p', path: 'D:\\Work\\demo', created_at: 0, last_opened_at: 0 })).toBe(
      'D:\\Work\\demo\\.qingcode\\project-settings.json',
    )
    expect(projectSettingsPath({ id: '1', name: 'p', path: 'D:/Work/demo', created_at: 0, last_opened_at: 0 })).toBe(
      'D:/Work/demo/.qingcode/project-settings.json',
    )
  })
})
