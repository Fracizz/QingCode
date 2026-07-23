import { describe, expect, it } from 'vitest'
import {
  disambiguateTerminalName,
  formatTerminalName,
  isGenericShellOscTitle,
  resolveNewTerminalName,
  shouldApplyOscTabTitle,
  terminalDisplayLabel,
} from './terminalName'

describe('formatTerminalName / terminalDisplayLabel', () => {
  it('localizes legacy Terminal N and shortens shell paths', () => {
    expect(formatTerminalName('Terminal 3')).toBe('终端 3')
    expect(formatTerminalName('powershell.exe')).toBe('PowerShell')
    expect(terminalDisplayLabel('C:\\Windows\\System32\\cmd.exe')).toBe('命令提示符')
  })
})

describe('resolveNewTerminalName / disambiguateTerminalName', () => {
  it('prefers custom profile name', () => {
    expect(resolveNewTerminalName('Dev', 'powershell.exe', '普通终端', 'PowerShell 7')).toBe('Dev')
  })

  it('falls back to command label or shell label', () => {
    expect(resolveNewTerminalName('普通终端', 'bash.exe', '普通终端', 'PowerShell 7')).toBe('Bash')
    expect(resolveNewTerminalName('普通终端', '', '普通终端', 'PowerShell 7')).toBe('PowerShell 7')
    expect(resolveNewTerminalName('', '', '普通终端', 'Zsh')).toBe('Zsh')
    expect(resolveNewTerminalName('普通终端', '', '普通终端', '')).toBe('终端')
  })

  it('disambiguates duplicate labels', () => {
    expect(disambiguateTerminalName('Bash', ['Bash', 'Bash (2)'])).toBe('Bash (3)')
    expect(disambiguateTerminalName('Bash', ['PowerShell'])).toBe('Bash')
  })
})

describe('isGenericShellOscTitle', () => {
  it('rejects default shell / ConPTY titles', () => {
    expect(isGenericShellOscTitle('powershell')).toBe(true)
    expect(isGenericShellOscTitle('Windows PowerShell')).toBe(true)
    expect(isGenericShellOscTitle('Administrator: Windows PowerShell')).toBe(true)
    expect(isGenericShellOscTitle('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(
      true,
    )
  })

  it('keeps app titles such as OpenCode', () => {
    expect(isGenericShellOscTitle('opencode')).toBe(false)
    expect(isGenericShellOscTitle('OpenCode')).toBe(false)
    expect(isGenericShellOscTitle('npm run dev')).toBe(false)
  })
})

describe('shouldApplyOscTabTitle', () => {
  it('allows cwd / app titles on normal and profile shells', () => {
    expect(shouldApplyOscTabTitle({}, 'qing-code')).toBe(true)
    expect(shouldApplyOscTabTitle({ shellKind: undefined }, 'opencode')).toBe(true)
    expect(shouldApplyOscTabTitle({ shellKind: 'interactive' }, 'OpenCode')).toBe(true)
  })

  it('blocks generic shell noise and run-config tasks', () => {
    expect(shouldApplyOscTabTitle({}, 'powershell')).toBe(false)
    expect(shouldApplyOscTabTitle({ shellKind: 'command' }, 'npm run dev')).toBe(false)
    expect(shouldApplyOscTabTitle({ shellKind: 'ps1' }, 'build')).toBe(false)
  })
})
