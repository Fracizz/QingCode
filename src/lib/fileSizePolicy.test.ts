import { describe, expect, it } from 'vitest'
import {
  EDIT_DEGRADED_BYTES,
  EDIT_MAX_BYTES,
  EDIT_WARN_BYTES,
  PLAIN_EDIT_MAX_BYTES,
  VIEW_MAX_BYTES,
  editorPerfProfile,
  fileOpenTier,
  formatFileSize,
} from './fileSizePolicy'

describe('fileSizePolicy', () => {
  it('tiers edit / edit-plain / view / reject', () => {
    expect(fileOpenTier(0)).toBe('edit')
    expect(fileOpenTier(EDIT_WARN_BYTES)).toBe('edit')
    expect(fileOpenTier(EDIT_DEGRADED_BYTES)).toBe('edit')
    expect(fileOpenTier(EDIT_MAX_BYTES)).toBe('edit')
    expect(fileOpenTier(EDIT_MAX_BYTES + 1)).toBe('edit-plain')
    expect(fileOpenTier(PLAIN_EDIT_MAX_BYTES)).toBe('edit-plain')
    expect(fileOpenTier(PLAIN_EDIT_MAX_BYTES + 1)).toBe('view')
    expect(fileOpenTier(VIEW_MAX_BYTES)).toBe('view')
    expect(fileOpenTier(VIEW_MAX_BYTES + 1)).toBe('reject')
  })

  it('maps sizes to editor performance profiles', () => {
    expect(editorPerfProfile(0)).toBe('full')
    expect(editorPerfProfile(EDIT_WARN_BYTES)).toBe('full')
    expect(editorPerfProfile(EDIT_DEGRADED_BYTES - 1)).toBe('full')
    expect(editorPerfProfile(EDIT_DEGRADED_BYTES)).toBe('degraded')
    expect(editorPerfProfile(EDIT_MAX_BYTES)).toBe('degraded')
    expect(editorPerfProfile(EDIT_MAX_BYTES + 1)).toBe('plain')
    expect(editorPerfProfile(PLAIN_EDIT_MAX_BYTES)).toBe('plain')
  })

  it('formats human-readable sizes', () => {
    expect(formatFileSize(800)).toBe('800 B')
    expect(formatFileSize(EDIT_MAX_BYTES)).toBe('20.0 MB')
    expect(formatFileSize(PLAIN_EDIT_MAX_BYTES)).toBe('100.0 MB')
  })
})
