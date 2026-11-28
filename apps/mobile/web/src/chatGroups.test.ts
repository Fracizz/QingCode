import type { ItemView, ThreadView, TurnMeta } from '@qn/codex-client'
import { describe, expect, it } from 'vitest'
import { chatTimeline, groupChatItems, hiddenToolTrails, isChatVisible, replyPhase, streamingReplyId, toolSummary, type ToolItem } from './chatGroups'

const command = (id: string, status = 'completed', exitCode: number | null = 0): ItemView =>
  ({ kind: 'command', id, command: 'ls', output: '', exitCode, status })
const agent = (id: string): ItemView => ({ kind: 'agent', id, text: 'ok', streaming: false })
const change = (id: string, paths: string[]): ItemView =>
  ({ kind: 'fileChange', id, changes: paths.map((path) => ({ path, kind: 'update' })), status: 'completed' })

describe('groupChatItems', () => {
  it('连续两个以上工具步骤折叠，单个保持原样', () => {
    const blocks = groupChatItems([agent('a'), command('c1'), agent('b'), command('c2'), change('f', ['x']), agent('d')])
    expect(blocks.map((block) => block.kind)).toEqual(['item', 'item', 'item', 'tools', 'item'])
    const tools = blocks[3]
    expect(tools?.kind === 'tools' && tools.items.map((item) => item.id)).toEqual(['c2', 'f'])
  })

  it('子代理详情入口独立于命令分组', () => {
    const subagent: ItemView = { kind: 'subagent', id: 'child', status: '运行中', title: '启动子代理', detail: '' }
    expect(groupChatItems([command('c1'), command('c2'), subagent]).at(-1)).toEqual({ kind: 'item', item: subagent })
  })
})

it('同一轮有多条流式标记时，只在最后一条回复仍在输出时显示提示', () => {
  const first: ItemView = { kind: 'agent', id: 'first', text: '检查中', streaming: true }
  const latest: ItemView = { kind: 'agent', id: 'latest', text: '正在总结', streaming: true }
  const thread: ThreadView = { id: 'thread', status: 'running', activeTurnId: 'turn', pendingApprovals: [], items: [first, latest] }
  expect(streamingReplyId(thread)).toBe('latest')
  expect(streamingReplyId({ ...thread, items: [latest, first], turns: [
    { id: 'turn', startedAtMs: 1, durationMs: null, itemIds: ['latest'] },
  ] })).toBe('latest')
  expect(streamingReplyId({ ...thread, items: [...thread.items, command('next')] })).toBeUndefined()
  expect(streamingReplyId({ ...thread, items: [first, { ...latest, streaming: false }] })).toBeUndefined()
  expect(streamingReplyId({ ...thread, status: 'idle' })).toBeUndefined()
})

describe('toolSummary', () => {
  it('统计命令、文件与失败数', () => {
    const items = [command('1'), command('2', 'failed', 1), change('f', ['a', 'b'])] as ToolItem[]
    expect(toolSummary(items)).toBe('已运行 2 条命令 · 改动 2 个文件 · 1 个失败')
  })
  it('有命令仍在运行时用进行时', () => {
    expect(toolSummary([command('1'), command('2', 'inProgress', null)] as ToolItem[])).toBe('正在运行 2 条命令')
  })
})

describe('手机消息流精简', () => {
  it('隐藏命令与其它工具步骤，保留回复与文件改动', () => {
    const items = [agent('a'), command('c'), change('f', ['x']), { kind: 'other', id: 'o', type: 'mcpToolCall', summary: '' } as ItemView]
    expect(items.filter(isChatVisible).map((item) => item.id)).toEqual(['a', 'f'])
  })

  it('按本轮最新一步给出回复阶段', () => {
    const streaming: ItemView = { kind: 'agent', id: 's', text: '…', streaming: true }
    expect(replyPhase([], undefined)).toBe('正在思考')
    expect(replyPhase([agent('a'), command('c', 'inProgress', null)], ['a', 'c'])).toBe('正在执行命令')
    expect(replyPhase([command('c'), streaming], ['c', 's'])).toBe('正在回复')
    expect(replyPhase([agent('old'), change('f', ['x'])], ['f'])).toBe('正在修改文件')
  })
})

it('中断标记保留在原轮次，支持只含隐藏命令或没有条目的轮次', () => {
  const items = [agent('a'), command('hidden'), agent('b')]
  const interrupted = (id: string, itemIds: string[]) => ({ id, itemIds, outcome: 'interrupted' as const, startedAtMs: null, durationMs: null })
  const timeline = chatTimeline(items, [
    interrupted('not-loaded', ['older']), interrupted('only-command', ['hidden']), interrupted('empty', []),
    { id: 'next', itemIds: ['b'], outcome: 'completed', startedAtMs: null, durationMs: null },
  ], false)
  // 隐藏的命令轮与空轮之间没有可见内容，提示合成一条。
  expect(timeline.map((entry) => entry.key)).toEqual(['a', 'stopped-empty', 'b'])
  expect(timeline[0]).toMatchObject({ kind: 'visible', trail: [{ id: 'hidden' }] })
})

it('历史页暂时只有思考步骤时也能显示工作用时', () => {
  const items: ItemView[] = [{ kind: 'reasoning', id: 'reason', summary: '准备检查', streaming: false }]
  const turns: TurnMeta[] = [{ id: 'turn', itemIds: ['reason'], startedAtMs: 1, durationMs: 544_000, outcome: 'completed' }]
  expect(chatTimeline(items, turns, false)).toMatchObject([
    { kind: 'work', durationMs: 544_000, entries: [{ kind: 'item', item: { id: 'reason' } }] },
  ])
})

describe('hiddenToolTrails', () => {
  const user = (id: string): ItemView => ({ kind: 'user', id, text: 'hi' } as ItemView)
  it('每轮隐藏的命令挂到该轮最后一条可见消息', () => {
    const trails = hiddenToolTrails([user('u1'), command('c1'), agent('a1'), command('c2'), agent('a2'), user('u2'), command('c3', 'failed', 1)])
    expect([...trails].map(([id, list]) => [id, list.map((item) => item.id)])).toEqual([['a2', ['c1', 'c2']], ['u2', ['c3']]])
  })
  it('进行中的一轮先不显示', () => {
    expect(hiddenToolTrails([user('u'), command('c'), agent('a')], ['c', 'a']).size).toBe(0)
  })
})
