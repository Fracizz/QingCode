import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../types'
import { terminalHoverDetails, terminalRowStatus } from './terminalTabPresentation'

const translate = (source: string, values?: Record<string, string | number>) =>
  values
    ? source.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
    : source

const base: TerminalTab = {
  id: 't1',
  projectId: 'p1',
  cwd: 'D:/app',
  status: 'running',
  exitCode: null,
  launchCommand: '',
  name: 'shell',
}

describe('terminalRowStatus', () => {
  it('names abnormal states and stays empty while running', () => {
    expect(terminalRowStatus({ ...base, status: 'exited' }, translate)).toBe('已退出')
    expect(terminalRowStatus({ ...base, status: 'reconnecting' }, translate)).toBe('重连中')
    expect(terminalRowStatus({ ...base, status: 'starting' }, translate)).toBe('启动中')
    expect(terminalRowStatus(base, translate)).toBeNull()
  })

  it('does not call a terminal waiting for restore exited', () => {
    expect(terminalRowStatus({ ...base, status: 'exited', awaitingRestoreSpawn: true }, translate)).toBeNull()
  })
})

describe('terminalHoverDetails', () => {
  it('lists the command and created time, skipping a command that repeats the name', () => {
    const details = terminalHoverDetails({ ...base, launchCommand: ' pnpm dev ' }, '2026-11-08 09:05', translate)
    expect(details.status).toBeUndefined()
    expect(details.rows).toEqual([
      { label: '启动命令', value: 'pnpm dev', mono: true },
      { label: '创建时间', value: '2026-11-08 09:05' },
    ])
    expect(terminalHoverDetails({ ...base, launchCommand: 'shell' }, null, translate).rows).toEqual([])
  })

  it('reports failed exits as danger and explains a waiting restore', () => {
    expect(terminalHoverDetails({ ...base, status: 'exited', exitCode: 1 }, null, translate).status).toEqual({
      text: '已退出（退出码 1）',
      tone: 'danger',
    })
    expect(
      terminalHoverDetails({ ...base, status: 'exited', awaitingRestoreSpawn: true }, null, translate).status,
    ).toEqual({ text: '切换到项目后恢复', tone: 'muted' })
  })

  it('says what happens to SSH terminals on disconnect', () => {
    const ssh = { ...base, cwd: 'ssh://conn/home/app' }
    expect(terminalHoverDetails({ ...ssh, persistent: true }, null, translate).rows).toEqual([
      { label: '断线后', value: '继续运行' },
    ])
    expect(
      terminalHoverDetails({ ...ssh, persistent: false, persistentFallbackReason: '无 tmux' }, null, translate).rows,
    ).toEqual([{ label: '断线后', value: '结束远端进程：无 tmux' }])
    expect(terminalHoverDetails({ ...base, persistent: false }, null, translate).rows).toEqual([])
  })
})
