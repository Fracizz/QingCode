import { describe, expect, it } from 'vitest'
import { EDIT_MAX_BYTES, parseMaxSizeForEditMap } from './fileSizePolicy'
import { mergeMaxSizeForEditMaps } from './fileSizeSettings'
import type { SettingsFile } from './projectSettings'

describe('fileSizeSettings merge', () => {
  it('overlays workspace patterns onto global map', () => {
    const global = {
      version: 1 as const,
      custom: {},
      'files.maxSizeForEdit': {
        '*': EDIT_MAX_BYTES,
        '*.log': 50 * 1024 * 1024,
      },
    } satisfies SettingsFile
    const workspace = {
      version: 1 as const,
      custom: {},
      'files.maxSizeForEdit': {
        '*.log': '80MB',
        '*.md': '30MB',
      },
    } satisfies SettingsFile

    const merged = mergeMaxSizeForEditMaps(global, workspace)
    expect(merged['*']).toBe(EDIT_MAX_BYTES)
    expect(merged['*.log']).toBe(80 * 1024 * 1024)
    expect(merged['*.md']).toBe(30 * 1024 * 1024)
  })

  it('keeps defaults when workspace omits the key', () => {
    const global = {
      version: 1 as const,
      custom: {},
      'files.maxSizeForEdit': parseMaxSizeForEditMap({ '*': '20MB', '*.txt': '50MB' }),
    } satisfies SettingsFile
    const workspace = { version: 1 as const, custom: {} } satisfies SettingsFile
    const merged = mergeMaxSizeForEditMaps(global, workspace)
    expect(merged['*.txt']).toBe(50 * 1024 * 1024)
  })
})
