import { describe, expect, it } from 'vitest'
import JSON5 from 'json5'
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_GLOBAL_SETTINGS_TEXT,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_PROJECT_SETTINGS_TEXT,
  PROJECTS_KEY,
  PROJECTS_SYNC_ON_STARTUP_KEY,
  UPDATE_CHECK_ON_STARTUP_KEY,
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

/** Every top-level settings key should have a JSON5 comment that names it. */
function assertTopLevelKeysHaveComments(text: string, settings: Record<string, unknown>) {
  for (const key of Object.keys(settings)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const commented = new RegExp(`//[^\\n]*${escaped}`)
    expect(commented.test(text), `missing comment for key: ${key}`).toBe(true)
  }
}

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
    expect(text).toContain('//')
  })

  it('formatSettings returns commented template when default keys are reordered', () => {
    const { custom, version, ...rest } = DEFAULT_GLOBAL_SETTINGS
    const reordered = { version, custom, ...rest } as typeof DEFAULT_GLOBAL_SETTINGS
    const text = formatSettings(reordered, 'global')
    expect(text).toContain('QingCode 全局设置')
    expect(text).toContain('// editor.fontSize：')

    const { custom: pCustom, version: pVersion, ...pRest } = DEFAULT_PROJECT_SETTINGS
    const projectReordered = { version: pVersion, custom: pCustom, ...pRest }
    const projectText = formatSettings(projectReordered, 'project')
    expect(projectText).toContain('QingCode 工作区设置')
    expect(projectText).toContain('//')
    expect(projectText).not.toContain('"qingcode.projects":')
  })

  it('formatSettings returns commented template for bare JSON5 dump of defaults', () => {
    const bare = `${JSON5.stringify(DEFAULT_GLOBAL_SETTINGS, null, 2)}\n`
    expect(bare).not.toContain('//')
    const parsed = parseSettingsText(bare, 'global')
    const text = formatSettings(parsed, 'global')
    expect(text).toContain('QingCode 全局设置')
    expect(text).toContain('// ============================== 编辑器')
  })

  it('formatSettings keeps comments when applying customized values', () => {
    const customized = {
      ...DEFAULT_GLOBAL_SETTINGS,
      'files.autoSave': 'afterDelay',
      'files.encoding': 'utf8',
      'search.followSymlinks': true,
    }
    const text = formatSettings(customized, 'global')
    expect(text).toContain('不得删除注释')
    expect(text).toContain('// files.autoSave：')
    expect(text).toContain('"files.autoSave": "afterDelay"')
    expect(text).toContain('"files.encoding": "utf8"')
    expect(text).toContain('"search.followSymlinks": true')
    // Unchanged object keys keep nested template comments.
    expect(text).toContain('// 版本控制元数据')
    const roundTrip = parseSettingsText(text, 'global')
    expect(roundTrip['files.autoSave']).toBe('afterDelay')
    expect(roundTrip['files.encoding']).toBe('utf8')
    expect(roundTrip['search.followSymlinks']).toBe(true)
  })

  it('default-settings JSON5 template comments every top-level key', () => {
    assertTopLevelKeysHaveComments(DEFAULT_GLOBAL_SETTINGS_TEXT, {
      ...DEFAULT_GLOBAL_SETTINGS,
      version: 1,
      [UPDATE_CHECK_ON_STARTUP_KEY]: true,
    })
    expect(DEFAULT_GLOBAL_SETTINGS_TEXT).toContain('// version：')
    expect(DEFAULT_GLOBAL_SETTINGS_TEXT).toContain('// files.encoding：')
    expect(DEFAULT_GLOBAL_SETTINGS_TEXT).toContain('// qingcode.projects')
    expect(DEFAULT_GLOBAL_SETTINGS_TEXT).toContain('不得删除注释')
  })

  it('project-settings JSON5 template comments every top-level key', () => {
    assertTopLevelKeysHaveComments(DEFAULT_PROJECT_SETTINGS_TEXT, {
      ...DEFAULT_PROJECT_SETTINGS,
      version: 1,
    })
    expect(DEFAULT_PROJECT_SETTINGS_TEXT).not.toContain('"qingcode.projects":')
    expect(DEFAULT_PROJECT_SETTINGS_TEXT).toContain('不得删除注释')
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
