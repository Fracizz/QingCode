import { describe, expect, it } from 'vitest'
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_GLOBAL_SETTINGS_TEXT, DEFAULT_PROJECT_SETTINGS_TEXT, parseSettingsText, formatSettings } from '../projectSettings'
import { parseShellPrewarmCount, SHELL_PREWARM_COUNT_KEY as KEY } from './shellPrewarmSettings'

describe('Windows shell prewarm settings', () => {
  it('accepts off and integer manual counts, defaults invalid values to auto', () => {
    for (let value = 0; value <= 8; value++) expect(parseShellPrewarmCount(value)).toBe(value)
    for (const value of [undefined, null, 'auto', '4', -1, 9, 1.5, NaN, Infinity, true, {}]) {
      expect(parseShellPrewarmCount(value)).toBe('auto')
    }
  })
  it('is global only and keeps JSON5 comments when saved', () => {
    expect(DEFAULT_GLOBAL_SETTINGS[KEY]).toBe('auto')
    expect(parseSettingsText(DEFAULT_GLOBAL_SETTINGS_TEXT)[KEY]).toBe('auto')
    expect(DEFAULT_GLOBAL_SETTINGS_TEXT).toContain('// terminal.integrated.shellPrewarmCount：')
    expect(DEFAULT_GLOBAL_SETTINGS_TEXT).toContain('不得删除注释')
    expect(parseSettingsText(DEFAULT_PROJECT_SETTINGS_TEXT, 'project')[KEY]).toBeUndefined()
    expect(parseSettingsText(`{ '${KEY}': 8 }`, 'project')[KEY]).toBeUndefined()
    for (const count of ['auto', 0, 1, 8]) {
      const text = formatSettings({ ...DEFAULT_GLOBAL_SETTINGS, [KEY]: count }, 'global')
      expect(parseSettingsText(text)[KEY]).toBe(count)
      expect(text).toContain('// terminal.integrated.shellPrewarmCount：')
    }
  })
})
