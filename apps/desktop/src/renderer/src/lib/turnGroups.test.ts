import { describe, expect, it } from 'vitest'
import type { ItemView, ThreadView } from '@qn/codex-client'
import { formatDuration, groupFlow, groupTurns, hasPendingSubmission, isGroupRunning, streamingReplyId, summarizeTools } from './turnGroups'

const user = (id: string) => ({ kind: 'user', id, text: 'hi' }) as unknown as ItemView
const agent = (id: string) => ({ kind: 'agent', id, text: 'ok', streaming: false }) as unknown as ItemView
const cmd = (id: string, exitCode: number | null = 0, status = 'completed') =>
  ({ kind: 'command', id, command: 'ls', output: '', status, exitCode, cwd: '' }) as unknown as ItemView
const file = (id: string, n = 1) =>
  ({ kind: 'fileChange', id, status: 'completed', changes: Array.from({ length: n }, (_, i) => ({ path: `f${i}`, kind: 'update' })) }) as unknown as ItemView
const think = (id: string, streaming = false, summary = '分析问题'): ItemView =>
  ({ kind: 'reasoning', id, summary, streaming })

describe('hasPendingSubmission', () => {
  const pendingUser: ItemView = { kind: 'user', id: 'new-user', text: '新问题', pending: true }

  it('提交时立即显示占位，上一轮回复不影响新一轮', () => {
    const items = [user('u'), agent('old-reply'), pendingUser]
    expect(hasPendingSubmission(items, true)).toBe(true)
    expect(hasPendingSubmission(items, false)).toBe(false)
  })

  it('已有实际回显时结束本地提交占位', () => {
    expect(hasPendingSubmission([user('u'), think('r')], true)).toBe(false)
    expect(hasPendingSubmission([pendingUser, agent('a')], true)).toBe(false)
  })
})

describe('streamingReplyId', () => {
  const stale: ItemView = { kind: 'agent', id: 'old', text: '检查了文件', streaming: true }
  const latest: ItemView = { kind: 'agent', id: 'new', text: '正在总结', streaming: true }
  const thread: ThreadView = {
    id: 'thread', status: 'running', activeTurnId: 'turn', items: [stale, cmd('c'), latest], pendingApprovals: [],
    turns: [{ id: 'turn', startedAtMs: 1, durationMs: null, itemIds: ['c', 'new', 'next-command'] }],
  }

  it('同一轮有多条流式标记时只取末尾回复', () => {
    expect(streamingReplyId(thread)).toBe('new')
    expect(streamingReplyId({ ...thread, turns: undefined })).toBe('new')
    expect(streamingReplyId({ ...thread, items: [latest, stale] })).toBe('new')
  })

  it('轮次结束或工具接管后不恢复旧回复的标记', () => {
    expect(streamingReplyId({ ...thread, status: 'idle' })).toBeUndefined()
    expect(streamingReplyId({ ...thread, items: [...thread.items, cmd('next-command')] })).toBeUndefined()
    expect(streamingReplyId({ ...thread, items: [stale, { ...latest, streaming: false }] })).toBeUndefined()
    expect(streamingReplyId({ ...thread, items: [stale] })).toBeUndefined()
  })
})

describe('groupFlow', () => {
  it('连续 2 个以上工具条目合并，单个保持原样', () => {
    const entries = groupFlow([user('u'), think('r'), cmd('c1'), cmd('c2'), agent('a'), cmd('c3'), agent('b')])
    expect(entries.map((e) => (e.kind === 'tools' ? `tools:${e.items.length}` : e.item.id))).toEqual([
      'u',
      'tools:3',
      'a',
      'c3',
      'b',
    ])
    expect(entries[1]!.key).toBe('tools-r')
  })

  it('末尾的工具条目也会被收尾', () => {
    expect(groupFlow([agent('a'), cmd('c1'), cmd('c2')]).at(-1)?.kind).toBe('tools')
    expect(groupFlow([])).toEqual([])
  })

  it('已结束的空摘要不计入工具组，正在思考的条目仍显示', () => {
    const command = cmd('c')
    expect(groupFlow([think('r', false, '  \n'), command])).toEqual([{ kind: 'item', key: 'c', item: command }])
    const streaming = think('r', true, '')
    expect(groupFlow([streaming, command])).toEqual([{ kind: 'tools', key: 'tools-r', items: [streaming, command] }])
  })
})

describe('summarizeTools', () => {
  it('统计命令、失败与文件', () => {
    expect(summarizeTools([cmd('1'), cmd('2', 1), cmd('3'), file('f', 2)])).toBe(
      '已运行 3 条命令 · 1 个失败 · 编辑了 2 个文件',
    )
  })

  it('只有思考时显示思考次数', () => {
    expect(summarizeTools([think('a'), think('b')])).toBe('思考了 2 次')
    expect(summarizeTools([think('a'), cmd('c')])).toBe('已运行 1 条命令')
  })
})

describe('groupTurns', () => {
  const kinds = (entries: ReturnType<typeof groupTurns>) =>
    entries.map((e) => (e.kind === 'item' ? e.item.id : e.kind === 'tools' ? `tools:${e.items.length}` : `work:${e.entries.length}`))

  it('已结束的轮次把过程收进 work，只露出最终回复', () => {
    const items = [user('u1'), think('r'), agent('mid'), cmd('c'), agent('a1'), user('u2'), agent('a2')]
    const turns = [{ id: 't1', startedAtMs: 1, durationMs: 296_000, itemIds: ['u1', 'c'] }]
    const entries = groupTurns(items, turns, false)
    expect(kinds(entries)).toEqual(['u1', 'work:3', 'a1', 'u2', 'a2'])
    expect(entries[1]!.kind === 'work' && entries[1]!.durationMs).toBe(296_000)
  })

  it('进行中的最后一轮保持展开', () => {
    const entries = groupTurns([user('u'), cmd('c1'), cmd('c2')], undefined, true)
    expect(kinds(entries)).toEqual(['u', 'tools:2'])
  })

  it('没有工具步骤时不折叠', () => {
    expect(kinds(groupTurns([user('u'), agent('a')], undefined, false))).toEqual(['u', 'a'])
  })

  it('完成的空摘要不生成可展开的工作过程', () => {
    const items = [user('u'), think('r1', false, ''), think('r2', false, '\n'), agent('a')]
    const turns = [{ id: 't', startedAtMs: 1, durationMs: 1000, itemIds: ['u', 'r1', 'r2', 'a'] }]
    expect(kinds(groupTurns(items, turns, false))).toEqual(['u', 'a'])
  })

  it('工作摘要使用紧随其后的最终回复时间', () => {
    const items: ItemView[] = [user('u'), cmd('c'),
      { kind: 'agent', id: 'mid', text: '进行中', streaming: false, completedAtMs: 1000 }, cmd('c2'),
      { kind: 'agent', id: 'final', text: '结束', streaming: false, completedAtMs: 2000 },
      { kind: 'agent', id: 'empty', text: '', streaming: false, completedAtMs: 3000 },
    ]
    expect(groupTurns(items, undefined, false)[1]).toMatchObject({ kind: 'work', reply: { id: 'final', completedAtMs: 2000 } })
    expect(groupTurns(items, undefined, true).some((entry) => entry.kind === 'work')).toBe(false)
  })
})

describe('formatDuration', () => {
  it('按秒、分、时格式化', () => {
    expect(formatDuration(4_200)).toBe('4s')
    expect(formatDuration(296_000)).toBe('4m 56s')
    expect(formatDuration(3_720_000)).toBe('1h 2m')
  })
})

describe('isGroupRunning', () => {
  it('任一命令运行中或思考流式中即为运行中', () => {
    expect(isGroupRunning([cmd('1'), cmd('2', null, 'inProgress')])).toBe(true)
    expect(isGroupRunning([think('a', true)])).toBe(true)
    expect(isGroupRunning([cmd('1'), file('f')])).toBe(false)
  })
})
