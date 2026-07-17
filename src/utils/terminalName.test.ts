import { describe, expect, it } from 'vitest'
import {
  disambiguateTerminalName,
  formatTerminalName,
  resolveNewTerminalName,
  terminalDisplayLabel,
} from './terminalName'

describe('formatTerminalName / terminalDisplayLabel', () => {
  it('localizes Terminal N and shortens shell paths', () => {
    expect(formatTerminalName('Terminal 3')).toBe('终端 3')
    expect(formatTerminalName('powershell.exe')).toBe('PowerShell')
    expect(terminalDisplayLabel('C:\\Windows\\System32\\cmd.exe')).toBe('命令提示符')
  })
})

describe('resolveNewTerminalName / disambiguateTerminalName', () => {
  it('prefers custom profile name', () => {
    expect(resolveNewTerminalName('Dev', 'powershell.exe', 2)).toBe('Dev')
  })

  it('falls back to command label or numbered terminal', () => {
    expect(resolveNewTerminalName('普通终端', 'bash.exe', 4)).toBe('Bash')
    expect(resolveNewTerminalName('普通终端', '', 5)).toBe('普通终端')
    expect(resolveNewTerminalName('', '', 5)).toBe('终端 5')
  })

  it('disambiguates duplicate labels', () => {
    expect(disambiguateTerminalName('Bash', ['Bash', 'Bash (2)'])).toBe('Bash (3)')
    expect(disambiguateTerminalName('Bash', ['PowerShell'])).toBe('Bash')
  })
})
