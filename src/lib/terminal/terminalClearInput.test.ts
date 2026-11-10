import { describe, expect, it } from 'vitest'
import {
  CLEAR_INPUT_EMACS,
  CLEAR_INPUT_WINDOWS,
  terminalClearInputSequence,
} from './terminalClearInput'

describe('terminalClearInputSequence', () => {
  it('AI CLI（bracketed paste）在任何 Shell 里都用 Ctrl+E Ctrl+U，不发 Esc', () => {
    for (const shell of ['powershell', 'pwsh', 'cmd', 'bash', 'auto', undefined] as const) {
      expect(terminalClearInputSequence({ shell, windowsHost: true, bracketedPaste: true })).toBe(
        CLEAR_INPUT_EMACS
      )
    }
  })

  it('Windows Shell 提示符用 Esc 清空整行', () => {
    for (const shell of ['powershell', 'pwsh', 'cmd'] as const) {
      expect(terminalClearInputSequence({ shell, windowsHost: false, bracketedPaste: false })).toBe(
        CLEAR_INPUT_WINDOWS
      )
    }
  })

  it('POSIX Shell 提示符用 Ctrl+E Ctrl+U', () => {
    for (const shell of ['bash', 'zsh', 'wsl'] as const) {
      expect(terminalClearInputSequence({ shell, windowsHost: true, bracketedPaste: false })).toBe(
        CLEAR_INPUT_EMACS
      )
    }
  })

  it('Shell 未解析时按主机系统选择', () => {
    expect(
      terminalClearInputSequence({ shell: 'auto', windowsHost: true, bracketedPaste: false })
    ).toBe(CLEAR_INPUT_WINDOWS)
    expect(
      terminalClearInputSequence({ shell: undefined, windowsHost: false, bracketedPaste: false })
    ).toBe(CLEAR_INPUT_EMACS)
  })
})
