import { describe, expect, it } from 'vitest'
import type { ItemView } from '@qn/codex-client'
import { groupFlow, isGroupRunning, summarizeTools } from './turnGroups'

const user = (id: string) => ({ kind: 'user', id, text: 'hi' }) as unknown as ItemView
const agent = (id: string) => ({ kind: 'agent', id, text: 'ok', streaming: false }) as unknown as ItemView
const cmd = (id: string, exitCode: number | null = 0, status = 'completed') =>
  ({ kind: 'command', id, command: 'ls', output: '', status, exitCode, cwd: '' }) as unknown as ItemView
const file = (id: string, n = 1) =>
  ({ kind: 'fileChange', id, status: 'completed', changes: Array.from({ length: n }, (_, i) => ({ path: `f${i}`, kind: 'update' })) }) as unknown as ItemView
const think = (id: string, streaming = false) => ({ kind: 'reasoning', id, summary: '', streaming }) as unknown as ItemView

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

describe('isGroupRunning', () => {
  it('任一命令运行中或思考流式中即为运行中', () => {
    expect(isGroupRunning([cmd('1'), cmd('2', null, 'inProgress')])).toBe(true)
    expect(isGroupRunning([think('a', true)])).toBe(true)
    expect(isGroupRunning([cmd('1'), file('f')])).toBe(false)
  })
})
