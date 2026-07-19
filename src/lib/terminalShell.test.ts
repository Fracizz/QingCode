import { describe, expect, it } from 'vitest'
import {
  availableTerminalShells,
  defaultTerminalShell,
  normalizeTerminalShell,
  terminalShellLabelKey,
} from './terminalShell'

describe('terminalShell', () => {
  it('defaults by platform (pwsh on Windows, zsh on macOS/Linux)', () => {
    expect(defaultTerminalShell('win')).toBe('pwsh')
    expect(defaultTerminalShell('unix')).toBe('zsh')
  })

  it('lists platform-appropriate shells with defaults first', () => {
    expect(availableTerminalShells('win')).toEqual(['pwsh', 'cmd', 'wsl', 'powershell'])
    expect(availableTerminalShells('unix')).toEqual(['zsh', 'bash', 'pwsh'])
  })

  it('normalizes missing and invalid values', () => {
    expect(normalizeTerminalShell(undefined, 'win')).toBe('pwsh')
    expect(normalizeTerminalShell('wsl', 'unix')).toBe('zsh')
    expect(normalizeTerminalShell('pwsh', 'win')).toBe('pwsh')
    expect(normalizeTerminalShell('nope', 'win')).toBe('pwsh')
    expect(normalizeTerminalShell('zsh', 'unix')).toBe('zsh')
  })

  it('exposes label keys', () => {
    expect(terminalShellLabelKey('cmd')).toBe('命令提示符')
    expect(terminalShellLabelKey('pwsh')).toBe('PowerShell 7')
    expect(terminalShellLabelKey('zsh')).toBe('Zsh')
  })
})
