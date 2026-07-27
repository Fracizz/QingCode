import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_STATE_CACHE_SIZE,
  MAX_EDITOR_STATE_CACHE_SIZE,
  MIN_EDITOR_STATE_CACHE_SIZE,
  parseEditorStateCacheSize,
  resolveEditorStateCacheSize,
} from './editorStateCacheSettings'

describe('editorStateCacheSettings', () => {
  it('uses automatic mode by default', () => {
    expect(parseEditorStateCacheSize(undefined)).toBe('auto')
    expect(parseEditorStateCacheSize('auto')).toBe('auto')
    expect(resolveEditorStateCacheSize('auto')).toBe(DEFAULT_EDITOR_STATE_CACHE_SIZE)
  })

  it('normalizes custom counts to the supported range', () => {
    expect(parseEditorStateCacheSize(0)).toBe(MIN_EDITOR_STATE_CACHE_SIZE)
    expect(parseEditorStateCacheSize(18.6)).toBe(19)
    expect(parseEditorStateCacheSize(999)).toBe(MAX_EDITOR_STATE_CACHE_SIZE)
    expect(parseEditorStateCacheSize('20')).toBe('auto')
  })
})
