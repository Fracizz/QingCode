import { describe, expect, it } from 'vitest'
import {
  availableTerminalShells,
  defaultTerminalShell,
  normalizeTerminalShell,
  terminalShellLabelKey,
} from './terminalShell'

describe('terminalShell', () => {
  it('defaults by platform (auto on Windows, zsh on macOS/Linux)', () => {
    expect(defaultTerminalShell('win')).toBe('auto')
    expect(defaultTerminalShell('unix')).toBe('zsh')
  })

  it('lists platform-appropriate shells with defaults first', () => {
    expect(availableTerminalShells('win')).toEqual(['auto', 'pwsh', 'powershell', 'cmd', 'wsl'])
    expect(availableTerminalShells('unix')).toEqual(['zsh', 'bash', 'pwsh'])
  })

  it('normalizes missing and invalid values', () => {
    expect(normalizeTerminalShell(undefined, 'win')).toBe('auto')
    expect(normalizeTerminalShell('wsl', 'unix')).toBe('zsh')
    expect(normalizeTerminalShell('pwsh', 'win')).toBe('pwsh')
    expect(normalizeTerminalShell('nope', 'win')).toBe('auto')
    expect(normalizeTerminalShell('zsh', 'unix')).toBe('zsh')
  })

  it('exposes label keys', () => {
    expect(terminalShellLabelKey('cmd')).toBe('命令提示符')
    expect(terminalShellLabelKey('auto')).toBe('自动选择')
    expect(terminalShellLabelKey('pwsh')).toBe('PowerShell 7')
    expect(terminalShellLabelKey('zsh')).toBe('Zsh')
  })
})
