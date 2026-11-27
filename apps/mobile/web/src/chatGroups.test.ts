import type { ItemView } from '@qn/codex-client'
import { describe, expect, it } from 'vitest'
import { groupChatItems, isChatVisible, replyPhase, toolSummary, type ToolItem } from './chatGroups'

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
