import type { TermInfo } from '@qn/protocol'
import { describe, expect, it } from 'vitest'
import { planTerminalReplay, restoreTerminalTabs } from './terminalModel'

const chunk = (seq: number) => ({ seq, data: btoa(String(seq)) })

function terminal(termId: string, cwd: string, startedAt: number, alive = true, backend: TermInfo['backend'] = 'python'): TermInfo {
  return {
    termId, cwd, startedAt, alive, backend, shell: '/bin/sh', args: [],
    pid: 1, supportsResize: true, lastSeq: 0, cols: 80, rows: 24,
  }
}

describe('终端接回', () => {
  it('按顺序合并回放和已在途的实时分块，忽略重传以及已消费的分块', () => {
    const replay = { mode: 'replay' as const, lastSeq: 5, chunks: [chunk(4), chunk(5)] }
    const plan = planTerminalReplay(3, replay, [chunk(7), chunk(4), chunk(3), chunk(6)])
    expect(plan).toMatchObject({ baseSeq: 3, reset: false, historyLost: false })
    expect(plan.chunks).toEqual([chunk(4), chunk(5), chunk(6), chunk(7)])
  })

  it('快照之后才开始回放，并保留已在途的后续分块', () => {
    const snapshot = { seq: 9, data: 'YQ==', cols: 132, rows: 40 }
    const plan = planTerminalReplay(
      3,
      { mode: 'snapshot', snapshot, lastSeq: 11, chunks: [chunk(10), chunk(11)] },
      [chunk(9), chunk(12)],
    )
    expect(plan).toEqual({
      baseSeq: 9, reset: true, historyLost: false, snapshot,
      chunks: [chunk(10), chunk(11), chunk(12)],
    })
  })

  it('无可用快照时从保留序号重画，并提示历史缺失', () => {
    const plan = planTerminalReplay(
      4,
      { mode: 'resync', lastSeq: 10, chunks: [chunk(9), chunk(10)] },
      [chunk(8), chunk(11)],
    )
    expect(plan).toMatchObject({ baseSeq: 8, reset: true, historyLost: true })
    expect(plan.chunks).toEqual([chunk(9), chunk(10), chunk(11)])
    expect(planTerminalReplay(10, { mode: 'resync', lastSeq: 0, chunks: [] }, []).baseSeq).toBe(0)
  })
})

describe('恢复项目终端标签', () => {
  it('只恢复同一项目，按启动顺序排列并保留选中项', () => {
    const first = terminal('first', 'C:\\Work\\App', 100, true, 'conpty')
    const second = terminal('second', 'c:/work/app/', 200, false, 'conpty')
    const other = terminal('other', 'C:\\Work\\Other', 1, true, 'conpty')
    expect(restoreTerminalTabs([second, other, first], 'C:/Work/App/.', 'second'))
      .toEqual({ tabs: [first, second], activeId: 'second' })
  })

  it('原标签消失时优先选择活跃终端，并区分 POSIX 大小写', () => {
    const stopped = terminal('stopped', '/work/app', 200, false)
    const active = terminal('active', '/work/app', 300)
    const other = terminal('other', '/work/App', 100)
    const backslash = terminal('backslash', '/work\\app', 310)
    expect(restoreTerminalTabs([other, stopped, active, backslash], '/work/app', other.termId))
      .toEqual({ tabs: [stopped, active], activeId: active.termId })
  })
})
