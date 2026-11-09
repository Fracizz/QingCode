import { describe, expect, it } from 'vitest'
import { terminalSessionMeta } from './terminalTabPresentation'

const translate = (source: string, values?: Record<string, string | number>) =>
  values
    ? source.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
    : source

const base = {
  status: 'running' as const,
  exitCode: null,
  launchCommand: '',
  name: 'shell',
  resolvedShell: undefined,
}

describe('terminalSessionMeta', () => {
  it('prefers abnormal states over the launch command', () => {
    expect(terminalSessionMeta({ ...base, status: 'exited', exitCode: 1, launchCommand: 'claude' }, translate))
      .toBe('已退出（退出码 1）')
    expect(terminalSessionMeta({ ...base, status: 'exited' }, translate)).toBe('已退出')
    expect(terminalSessionMeta({ ...base, status: 'reconnecting' }, translate)).toBe('正在重新连接…')
    expect(terminalSessionMeta({ ...base, status: 'starting' }, translate)).toBe('正在启动…')
  })

  it('shows the launch command unless it only repeats the name', () => {
    expect(terminalSessionMeta({ ...base, launchCommand: ' pnpm dev ' }, translate)).toBe('pnpm dev')
    expect(terminalSessionMeta({ ...base, launchCommand: 'shell' }, translate)).toBe('')
  })

  it('is empty when there is nothing useful to show', () => {
    expect(terminalSessionMeta(base, translate)).toBe('')
  })
})
