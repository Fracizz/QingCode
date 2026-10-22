import { describe, expect, it } from 'vitest'
import {
  parseTerminalSshUploadOnPaste,
  readTerminalSshUploadOnPaste,
  SSH_UPLOAD_ON_PASTE_KEY,
} from '@/lib/terminal/terminalSshUploadSettings'
import { DEFAULT_GLOBAL_SETTINGS } from '@/lib/projectSettings'

describe('terminalSshUploadSettings', () => {
  it('defaults off when unset', () => {
    expect(parseTerminalSshUploadOnPaste(undefined)).toBe(false)
    expect(parseTerminalSshUploadOnPaste(false)).toBe(false)
    expect(parseTerminalSshUploadOnPaste(true)).toBe(true)
    expect(parseTerminalSshUploadOnPaste('true')).toBe(false)
  })

  it('reads terminal.integrated.sshUploadOnPaste', () => {
    expect(readTerminalSshUploadOnPaste(DEFAULT_GLOBAL_SETTINGS)).toBe(false)
    expect(
      readTerminalSshUploadOnPaste({
        ...DEFAULT_GLOBAL_SETTINGS,
        [SSH_UPLOAD_ON_PASTE_KEY]: true,
      }),
    ).toBe(true)
  })
})
