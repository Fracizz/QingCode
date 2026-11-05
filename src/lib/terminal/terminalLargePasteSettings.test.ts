import { describe, expect, it } from 'vitest'
import { DEFAULT_GLOBAL_SETTINGS } from '@/lib/projectSettings'
import {
  LARGE_PASTE_AS_FILE_KEY,
  parseTerminalLargePasteAsFile,
  readTerminalLargePasteAsFile,
} from './terminalLargePasteSettings'

describe('terminal large paste settings', () => {
  it('only treats literal true as enabled', () => {
    expect(parseTerminalLargePasteAsFile(undefined)).toBe(false)
    expect(parseTerminalLargePasteAsFile(false)).toBe(false)
    expect(parseTerminalLargePasteAsFile('true')).toBe(false)
    expect(parseTerminalLargePasteAsFile(true)).toBe(true)
  })

  it('reads terminal.integrated.largePasteAsFile and defaults to asking', () => {
    expect(readTerminalLargePasteAsFile({ [LARGE_PASTE_AS_FILE_KEY]: true })).toBe(true)
    expect(readTerminalLargePasteAsFile(DEFAULT_GLOBAL_SETTINGS)).toBe(false)
  })
})
