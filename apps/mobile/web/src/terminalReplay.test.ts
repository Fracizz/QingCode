import { describe, expect, it } from 'vitest'
import { decodeTerminalOutput, encodeTerminalInput, planMobileTerminalReplay } from './terminalReplay'

const chunk = (seq: number, data = 'YQ==') => ({ seq, data })

describe('移动终端回放', () => {
  it('对重叠的回放与实时事件去重并按序应用', () => {
    const replay = planMobileTerminalReplay(1, { mode: 'replay', chunks: [chunk(2), chunk(3)], lastSeq: 3 },
      [chunk(4), chunk(3, 'Yg=='), chunk(1)])
    expect(replay).toMatchObject({ reset: false, baseSeq: 1, gap: false, chunks: [chunk(2), chunk(3), chunk(4)] })
  })

  it('先应用快照，缺少快照时只保留缓冲内的历史', () => {
    const snapshot = { seq: 10, data: 'Yg==', cols: 80, rows: 24 }
    expect(planMobileTerminalReplay(1, { mode: 'snapshot', lastSeq: 11, chunks: [chunk(11)], snapshot }, []))
      .toMatchObject({ reset: true, baseSeq: 10, snapshot, historyLost: false, chunks: [chunk(11)] })
    expect(planMobileTerminalReplay(1, { mode: 'resync', lastSeq: 20, chunks: [chunk(19), chunk(20)] }, []))
      .toMatchObject({ reset: true, baseSeq: 18, historyLost: true, gap: false })
  })

  it('保留缺口前的数据，下次从缺口起点接回', () => {
    const replay = planMobileTerminalReplay(2, { mode: 'replay', chunks: [chunk(3)], lastSeq: 3 }, [chunk(5)])
    expect(replay).toMatchObject({ gap: true, baseSeq: 2, chunks: [chunk(3)] })
  })

  it('保留 UTF-8 输入与二进制控制序列', () => {
    const bytes = new TextEncoder().encode('终端\u0003\n')
    expect(decodeTerminalOutput(encodeTerminalInput(bytes))).toEqual(bytes)
  })
})
