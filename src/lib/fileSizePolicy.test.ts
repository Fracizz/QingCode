import { describe, expect, it, beforeEach } from 'vitest'
import {
  DEFAULT_MAX_SIZE_FOR_EDIT,
  EDIT_DEGRADED_BYTES,
  EDIT_MAX_BYTES,
  EDIT_WARN_BYTES,
  PLAIN_EDIT_MAX_BYTES,
  VIEW_MAX_BYTES,
  editorPerfProfile,
  fileOpenTier,
  formatFileSize,
  matchFileSizePattern,
  parseMaxSizeForEditMap,
  parseSizeToBytes,
  resolveEditMaxBytes,
  setActiveMaxSizeForEdit,
} from './fileSizePolicy'

describe('fileSizePolicy', () => {
  beforeEach(() => {
    setActiveMaxSizeForEdit(DEFAULT_MAX_SIZE_FOR_EDIT)
  })

  it('tiers edit / edit-plain / view / reject with default edit max', () => {
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

  it('tiers by extension-specific edit max for log-class files', () => {
    const logEdit = resolveEditMaxBytes('D:/logs/app.log')
    expect(logEdit).toBe(50 * 1024 * 1024)
    expect(fileOpenTier(30 * 1024 * 1024, logEdit)).toBe('edit')
    expect(fileOpenTier(60 * 1024 * 1024, logEdit)).toBe('edit-plain')
    expect(fileOpenTier(120 * 1024 * 1024, logEdit)).toBe('view')

    const codeEdit = resolveEditMaxBytes('D:/src/main.ts')
    expect(codeEdit).toBe(EDIT_MAX_BYTES)
    expect(fileOpenTier(30 * 1024 * 1024, codeEdit)).toBe('edit-plain')
  })

  it('maps sizes to editor performance profiles with custom edit max', () => {
    expect(editorPerfProfile(0)).toBe('full')
    expect(editorPerfProfile(EDIT_WARN_BYTES)).toBe('full')
    expect(editorPerfProfile(EDIT_DEGRADED_BYTES - 1)).toBe('full')
    expect(editorPerfProfile(EDIT_DEGRADED_BYTES)).toBe('degraded')
    expect(editorPerfProfile(EDIT_MAX_BYTES)).toBe('degraded')
    expect(editorPerfProfile(EDIT_MAX_BYTES + 1)).toBe('plain')
    expect(editorPerfProfile(PLAIN_EDIT_MAX_BYTES)).toBe('plain')

    const logEdit = 50 * 1024 * 1024
    expect(editorPerfProfile(30 * 1024 * 1024, logEdit)).toBe('degraded')
    expect(editorPerfProfile(logEdit + 1, logEdit)).toBe('plain')
  })

  it('formats human-readable sizes', () => {
    expect(formatFileSize(800)).toBe('800 B')
    expect(formatFileSize(EDIT_MAX_BYTES)).toBe('20.0 MB')
    expect(formatFileSize(PLAIN_EDIT_MAX_BYTES)).toBe('100.0 MB')
  })

  it('parses size strings and numbers', () => {
    expect(parseSizeToBytes(20971520)).toBe(20971520)
    expect(parseSizeToBytes('20MB')).toBe(20 * 1024 * 1024)
    expect(parseSizeToBytes('50 mb')).toBe(50 * 1024 * 1024)
    expect(parseSizeToBytes('1024KB')).toBe(1024 * 1024)
    expect(parseSizeToBytes('nope')).toBeNull()
  })

  it('matches simple glob patterns for maxSizeForEdit', () => {
    expect(matchFileSizePattern('*', 'a.ts')).toBe(true)
    expect(matchFileSizePattern('*.log', 'D:\\x\\app.LOG')).toBe(true)
    expect(matchFileSizePattern('**/*.txt', 'notes.txt')).toBe(true)
    expect(matchFileSizePattern('*.{log,txt}', 'a.txt')).toBe(true)
    expect(matchFileSizePattern('*.{log,txt}', 'a.json')).toBe(false)
    expect(matchFileSizePattern('*.json', 'a.ts')).toBe(false)
  })

  it('resolves most specific pattern and clamps to plain cap', () => {
    const rules = parseMaxSizeForEditMap({
      '*': '20MB',
      '*.log': '50MB',
      '*.json': 999 * 1024 * 1024,
    })
    expect(resolveEditMaxBytes('x.ts', rules)).toBe(EDIT_MAX_BYTES)
    expect(resolveEditMaxBytes('x.log', rules)).toBe(50 * 1024 * 1024)
    // Cannot raise above plain/edit hard cap (100MB).
    expect(resolveEditMaxBytes('x.json', rules)).toBe(PLAIN_EDIT_MAX_BYTES)
  })
})
