import { describe, expect, it } from 'vitest'
import {
  enabledExcludePatterns,
  isPathExcluded,
  mergeExcludeMaps,
  pathMatchesExclude,
  readEffectiveExcludeSettings,
  readExcludeMap,
  vscodeGlobMatch,
} from './excludeSettings'
import { DEFAULT_GLOBAL_SETTINGS, type SettingsFile } from './projectSettings'

describe('vscodeGlobMatch', () => {
  it('matches **/folder at any depth including root', () => {
    expect(vscodeGlobMatch('node_modules', '**/node_modules')).toBe(true)
    expect(vscodeGlobMatch('pkg/node_modules', '**/node_modules')).toBe(true)
    expect(vscodeGlobMatch('a/b/node_modules', '**/node_modules')).toBe(true)
    expect(vscodeGlobMatch('src', '**/node_modules')).toBe(false)
  })

  it('matches extension globs', () => {
    expect(vscodeGlobMatch('foo.code-search', '**/*.code-search')).toBe(true)
    expect(vscodeGlobMatch('a/b/foo.code-search', '**/*.code-search')).toBe(true)
    expect(vscodeGlobMatch('foo.ts', '**/*.code-search')).toBe(false)
  })

  it('keeps * within a single segment', () => {
    expect(vscodeGlobMatch('foo.tmp', '*.tmp')).toBe(true)
    expect(vscodeGlobMatch('a/foo.tmp', '*.tmp')).toBe(false)
  })
})

describe('pathMatchesExclude', () => {
  it('excludes children when a parent folder matches', () => {
    expect(pathMatchesExclude('node_modules/lodash/index.js', '**/node_modules')).toBe(true)
    expect(pathMatchesExclude('dist/app.js', '**/dist')).toBe(true)
    expect(pathMatchesExclude('src/app.js', '**/dist')).toBe(false)
  })

  it('normalizes windows separators', () => {
    expect(pathMatchesExclude('pkg\\node_modules\\x', '**/node_modules')).toBe(true)
  })
})

describe('isPathExcluded / maps', () => {
  it('reads enabled patterns and respects false overrides', () => {
    const map = mergeExcludeMaps(
      { '**/node_modules': true, '**/dist': true },
      { '**/node_modules': false, '**/coverage': true },
    )
    expect(map['**/node_modules']).toBe(false)
    expect(enabledExcludePatterns(map).sort()).toEqual(['**/coverage', '**/dist'])
  })

  it('readExcludeMap fills from defaults', () => {
    const settings = {
      version: 1 as const,
      custom: {},
      'files.exclude': { '**/my-secret': true },
    }
    const map = readExcludeMap(settings, 'files.exclude')
    expect(map['**/node_modules']).toBe(true)
    expect(map['**/my-secret']).toBe(true)
  })

  it('search exclude unions files.exclude with search.exclude', () => {
    const settings: SettingsFile = {
      ...DEFAULT_GLOBAL_SETTINGS,
      'files.exclude': { '**/dist': true, '**/keep': false },
      'search.exclude': { '**/*.code-search': true, '**/dist': false },
    }
    const effective = readEffectiveExcludeSettings(settings)
    expect(isPathExcluded('dist/a.js', effective.filesExclude)).toBe(true)
    // search.exclude sets **/dist false → not in search exclude list
    expect(effective.searchExclude.includes('**/dist')).toBe(false)
    expect(effective.searchExclude.some(p => p.includes('code-search'))).toBe(true)
  })

  it('reads ignore / symlink flags from settings', () => {
    const defaults = readEffectiveExcludeSettings(DEFAULT_GLOBAL_SETTINGS)
    expect(defaults.excludeGitIgnore).toBe(true)
    expect(defaults.useIgnoreFiles).toBe(true)
    expect(defaults.followSymlinks).toBe(false)

    const overridden = readEffectiveExcludeSettings({
      ...DEFAULT_GLOBAL_SETTINGS,
      'explorer.excludeGitIgnore': false,
      'search.useIgnoreFiles': false,
      'search.followSymlinks': true,
    })
    expect(overridden.excludeGitIgnore).toBe(false)
    expect(overridden.useIgnoreFiles).toBe(false)
    expect(overridden.followSymlinks).toBe(true)
  })
})
