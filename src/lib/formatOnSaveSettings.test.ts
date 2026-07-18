import { describe, expect, it } from 'vitest'
import { parseFormatOnSave, readFormatOnSave } from './formatOnSaveSettings'
import { DEFAULT_GLOBAL_SETTINGS } from './projectSettings'

describe('formatOnSaveSettings', () => {
  it('parses boolean only', () => {
    expect(parseFormatOnSave(true)).toBe(true)
    expect(parseFormatOnSave(false)).toBe(false)
    expect(parseFormatOnSave('true')).toBe(false)
    expect(parseFormatOnSave(1)).toBe(false)
  })

  it('reads editor.formatOnSave from settings', () => {
    expect(readFormatOnSave({ ...DEFAULT_GLOBAL_SETTINGS, 'editor.formatOnSave': true })).toBe(
      true,
    )
    expect(readFormatOnSave(DEFAULT_GLOBAL_SETTINGS)).toBe(false)
  })
})
