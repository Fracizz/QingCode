import { describe, expect, it } from 'vitest'
import { mergeThreadSummaries, nextCopyTitle, refreshThreadOrder, threadKey, threadPreviewText, toThreadSummaries, toTimestamp, withLocalThreads } from './threads'

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

  it('完成后更新时间和状态但保留原位，新增会话排前，归档会话移除', () => {
    const [first, removed] = toThreadSummaries([{ id: 'same' }, { id: 'removed' }])
    const [running] = toThreadSummaries([{ id: 'same', status: { type: 'active', activeFlags: [] } }], 'claude')
    const [finished, added] = toThreadSummaries([
      { id: 'same', updatedAt: 500, status: { type: 'idle' } },
      { id: 'new', updatedAt: 400 },
    ], 'claude')
    const incoming = [finished!, added!, first!]
    expect(refreshThreadOrder([], incoming)).toEqual(incoming)
    expect(refreshThreadOrder([first!, running!, removed!], incoming)).toEqual([added, first, finished])
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

describe('会话悬浮摘要', () => {
  it('只保留标题之外的内容，兼容已经截断的首行', () => {
    expect(threadPreviewText({ title: '第一行', preview: '第一行\r\n第二行\n第三行' })).toBe('第二行\n第三行')
    expect(threadPreviewText({ title: '第一行', preview: '第一行' })).toBe('')

    const [thread] = toThreadSummaries([{ id: 'long', preview: '长标题'.repeat(60) }])
    expect(thread!.preview).toMatch(/…$/)
    expect(threadPreviewText(thread!)).toBe('')
  })

  it('保留自定义标题对应的独立摘要', () => {
    expect(threadPreviewText({ title: '第一行', preview: ' 第一行后面还有内容 ' })).toBe('第一行后面还有内容')
    expect(threadPreviewText({ title: '第一行', preview: '第一…' })).toBe('第一…')
    expect(threadPreviewText({ title: '第一行', preview: '' })).toBe('')
  })
})

describe('withLocalThreads', () => {
  const summary = (id: string, cwd: string, updatedAt: number) =>
    ({ id, title: id, preview: '', cwd, updatedAt, agent: 'codex' as const })

  it('补入服务端尚未列出的本地新会话，并按项目过滤', () => {
    const listed = summary('old', '/p', 1)
    const fresh = summary('new', '/p', 2)
    const other = summary('x', '/q', 3)
    expect(withLocalThreads([listed], [fresh, other], '/p')).toEqual([fresh, listed])
    expect(withLocalThreads([listed], [fresh, other], null)).toEqual([other, fresh, listed])
  })

  it('服务端已返回的会话以服务端为准', () => {
    const server = { ...summary('new', '/p', 5), title: '服务端标题' }
    expect(withLocalThreads([server], [summary('new', '/p', 2)], '/p')).toEqual([server])
  })
})

describe('nextCopyTitle', () => {
  it('首个分支编号为 2，之后按同名系列最大编号递增', () => {
    expect(nextCopyTitle('用量和额度', ['用量和额度'])).toBe('用量和额度 (2)')
    expect(nextCopyTitle('用量和额度', ['用量和额度', '用量和额度 (2)', '用量和额度 (4)'])).toBe('用量和额度 (5)')
  })

  it('从分支再分支时去掉原有后缀，不叠加', () => {
    expect(nextCopyTitle('任务 (2)', ['任务', '任务 (2)'])).toBe('任务 (3)')
  })

  it('不同标题的编号互不影响', () => {
    expect(nextCopyTitle('甲', ['甲乙 (7)', '乙 (3)'])).toBe('甲 (2)')
  })
})
