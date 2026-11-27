import { describe, expect, it } from 'vitest'
import { mergeThreadSummaries, threadKey, toThreadSummaries, toTimestamp } from './threads'

describe('会话列表归一化', () => {
  it('兼容秒/毫秒时间戳', () => {
    expect(toTimestamp(1_700_000_000)).toBe(1_700_000_000_000)
    expect(toTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(toTimestamp(0)).toBe(0)
    expect(toTimestamp('bad')).toBe(0)
    expect(toTimestamp(Number.NaN)).toBe(0)
  })

  it('按更新时间降序，缺省标题回退到 preview', () => {
    const result = toThreadSummaries({
      data: [
        { id: 'a', name: null, preview: '第一行\n第二行', cwd: '/a', updatedAt: 1_700_000_000 },
        { id: 'b', name: '显式标题', preview: '', cwd: '/b', updatedAt: 1_700_000_100 },
        { id: 'c', name: '', preview: '', cwd: '/c', recencyAt: 1_700_000_050 },
        { id: '', preview: '无效' },
        null,
      ],
    })
    expect(result.map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
    expect(result[2]?.title).toBe('第一行')
    expect(result[2]?.preview).toBe('第一行\n第二行')
    expect(result[1]?.updatedAt).toBe(1_700_000_050_000)
  })

  it('接受裸数组与非法输入', () => {
    expect(toThreadSummaries([{ id: 'x', preview: 'hi' }])).toHaveLength(1)
    expect(toThreadSummaries(undefined)).toEqual([])
  })

  it('保留尚未打开的会话在列表中报告的状态', () => {
    const threads = toThreadSummaries([
      { id: 'approval', status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
      { id: 'input', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } },
      { id: 'failed', status: { type: 'systemError' } },
    ])
    expect(threads.map((thread) => thread.activity)).toEqual(['pending', 'input', 'failed'])
  })

  it('给会话标上 agent 并合并两个来源', () => {
    const codex = toThreadSummaries({ data: [{ id: 'c1', updatedAt: 1_700_000_000 }] })
    const claude = toThreadSummaries({ data: [{ id: 'l1', updatedAt: 1_700_000_100 }] }, 'claude')
    expect(codex[0]?.agent).toBe('codex')
    expect(claude[0]?.agent).toBe('claude')
    expect(mergeThreadSummaries([codex, claude]).map((entry) => entry.id)).toEqual(['l1', 'c1'])
    expect(threadKey('claude', 'l1')).toBe('claude:l1')
  })
})
