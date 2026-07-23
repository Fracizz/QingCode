import { describe, expect, it } from 'vitest'
import { guessLanguage, isPinnedSettingsTab, tabNameFromPath } from './editorHelpers'

describe('tabNameFromPath', () => {
  it('uses the final path segment', () => {
    expect(tabNameFromPath('D:/a/b/c.ts')).toBe('c.ts')
    expect(tabNameFromPath('D:\\a\\b\\c.ts')).toBe('c.ts')
  })
})

describe('isPinnedSettingsTab', () => {
  it('only pins global default-settings.json', () => {
    expect(isPinnedSettingsTab('C:/App/default-settings.json')).toBe(true)
    expect(isPinnedSettingsTab('D:/proj/.qingcode/project-settings.json')).toBe(false)
  })
})

describe('guessLanguage', () => {
  it('maps common extensions', () => {
    expect(guessLanguage('a.ts')).toBe('typescript')
    expect(guessLanguage('a.java')).toBe('java')
    expect(guessLanguage('a.rs')).toBe('rust')
    expect(guessLanguage('a.yaml')).toBe('yaml')
    expect(guessLanguage('a.yml')).toBe('yaml')
    expect(guessLanguage('Cargo.toml')).toBe('toml')
    expect(guessLanguage('run.sh')).toBe('shell')
    expect(guessLanguage('run.bash')).toBe('shell')
    expect(guessLanguage('main.go')).toBe('go')
    expect(guessLanguage('a.unknown')).toBe('plain')
  })

  it('treats settings files as json5', () => {
    expect(guessLanguage('C:/x/default-settings.json')).toBe('json5')
    expect(guessLanguage('D:/p/.qingcode/project-settings.json')).toBe('json5')
  })
})
