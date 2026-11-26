import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { MapContext, V2Notification } from '../claude/v2'
import {
  addUsage,
  contentText,
  emptyMapState,
  finishTurnNotifications,
  mapPiEvent,
  messagesToThread,
  piFileChanges,
  piThread,
  piTokenUsage,
  piToolItem,
  type MapState,
} from './items'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'real-prompt.jsonl')
const ctx: MapContext = { threadId: 'thread-1', turnId: 'turn-1', cwd: '/work' }

function realEvents(): unknown[] {
  return fs
    .readFileSync(fixture, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
}

function replay(events: unknown[], state0 = emptyMapState()): {
  notes: V2Notification[]
  state: MapState
  turnEnd?: { status: string; error: string | null }
} {
  let state = state0
  const notes: V2Notification[] = []
  let turnEnd: { status: string; error: string | null } | undefined
  for (const event of events) {
    const mapped = mapPiEvent(event, ctx, state)
    state = mapped.state
    notes.push(...mapped.notifications)
    if (mapped.turnEnd) turnEnd = mapped.turnEnd
  }
  return { notes, state, turnEnd }
}

describe('真实 pi 录制事件回放 → v2 通知', () => {
  it('fixture 是真实录制的会话事件且不含凭据字段', () => {
    const events = realEvents()
    expect(events.length).toBeGreaterThan(40)
    expect(events.some((event) => (event as { type?: string }).type === 'agent_settled')).toBe(true)
    const text = fs.readFileSync(fixture, 'utf8')
    expect(text).not.toMatch(/(api[_-]?key|password|passphrase|Bearer |auth\.json|sk-[A-Za-z0-9]{8,})/i)
  })

  it('文本/思考增量、bash 命令项、tokenUsage、turn/completed 全部映射出来', () => {
    const { notes, turnEnd } = replay(realEvents())
    const methods = notes.map((note) => note.method)
    expect(methods).toContain('item/agentMessage/delta')
    expect(methods).toContain('item/reasoning/summaryTextDelta')
    expect(methods).toContain('item/started')
    expect(methods).toContain('item/completed')

    const commandStarted = notes.find(
      (note) =>
        note.method === 'item/started' &&
        (note.params.item as { type?: string })?.type === 'commandExecution',
    )
    expect((commandStarted?.params.item as { command?: string })?.command).toBe('ls -la')

    const commandCompleted = notes.find(
      (note) =>
        note.method === 'item/completed' &&
        (note.params.item as { type?: string })?.type === 'commandExecution',
    )
    const item = commandCompleted?.params.item as {
      status?: string
      aggregatedOutput?: string
      exitCode?: number | null
    }
    expect(item?.status).toBe('completed')
    expect(item?.aggregatedOutput).toContain('hello.txt')
    expect(item?.exitCode).toBe(0)

    const agentDelta = notes
      .filter((note) => note.method === 'item/agentMessage/delta')
      .map((note) => String(note.params.delta))
      .join('')
    expect(agentDelta).toContain('hello.txt')

    const completed = notes.filter((note) => note.method === 'turn/completed')
    expect(completed).toHaveLength(1)
    expect((completed[0]?.params.turn as { status?: string })?.status).toBe('completed')
    expect(turnEnd?.status).toBe('completed')

    const usage = notes.find((note) => note.method === 'thread/tokenUsage/updated')
    const tokenUsage = usage?.params.tokenUsage as { total?: { totalTokens?: number } }
    expect(tokenUsage?.total?.totalTokens).toBeGreaterThan(0)

    // pi 没有审批机制：绝不伪造 requestApproval。
    expect(methods.some((method) => method.includes('requestApproval'))).toBe(false)
  })
})

describe('turn 结束状态', () => {
  it('abort 后的 agent_settled 映射为 interrupted', () => {
    const { notes, turnEnd } = replay([
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'agent_settled', aborted: true },
    ])
    const completed = notes.find((note) => note.method === 'turn/completed')
    expect((completed?.params.turn as { status?: string })?.status).toBe('interrupted')
    expect(turnEnd?.status).toBe('interrupted')
  })

  it('provider 错误映射为 failed，并把原因写进 turn.error', () => {
    const { notes } = replay([
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'error', reason: 'aborted', error: { errorMessage: '上游不可用' } },
      },
      { type: 'agent_settled', aborted: false },
    ])
    const completed = notes.find((note) => note.method === 'turn/completed')
    const turn = completed?.params.turn as { status?: string; error?: { message?: string } }
    expect(turn?.status).toBe('failed')
    expect(turn?.error?.message).toContain('上游不可用')
  })

  it('仍在 inProgress 的 item 在轮次结束时补 completed', () => {
    const state = emptyMapState()
    state.items.i1 = { type: 'commandExecution', id: 'i1', status: 'inProgress', exitCode: null }
    state.order.push('i1')
    const notes = finishTurnNotifications(ctx, state, 'failed', '出错了')
    const completed = notes.find(
      (note) => note.method === 'item/completed' && note.params.itemId === 'i1',
    )
    expect((completed?.params.item as { status?: string; exitCode?: number })?.status).toBe('failed')
    expect((completed?.params.item as { exitCode?: number })?.exitCode).toBe(1)
  })
})

describe('pi 工具 → v2 item', () => {
  it('bash/powershell → commandExecution，edit/write → fileChange（统一 diff），其它 → dynamicToolCall', () => {
    expect(piToolItem('i1', 'bash', { command: 'ls -la' }, '/work')).toMatchObject({
      type: 'commandExecution',
      command: 'ls -la',
      cwd: '/work',
    })
    expect(piToolItem('i2', 'powershell', { command: 'Get-ChildItem' }, 'C:/w').type).toBe(
      'commandExecution',
    )
    const write = piToolItem('i3', 'write', { path: 'a.ts', content: 'let a = 1\n' }, '/work')
    expect(write.type).toBe('fileChange')
    expect((write.changes as { diff: string }[])[0]?.diff).toContain('+let a = 1')
    expect(piToolItem('i4', 'read', { path: 'a.ts' }, '/work').type).toBe('dynamicToolCall')
  })

  it('edit 的 edits 数组逐项生成统一 diff', () => {
    const changes = piFileChanges('edit', {
      path: 'a.ts',
      edits: [
        { oldText: 'const a = 1', newText: 'const a = 2' },
        { oldText: 'foo()', newText: 'bar()' },
      ],
    })
    expect(changes).toHaveLength(1)
    expect(String((changes[0] as { diff: string }).diff)).toContain('-const a = 1')
    expect(String((changes[0] as { diff: string }).diff)).toContain('+bar()')
  })

  it('contentText 兼容字符串与文本块数组', () => {
    expect(contentText('hello')).toBe('hello')
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })
})

describe('用量与历史', () => {
  it('usage 按 assistant 消息累加，reasoning 已包含在 output 里不重复计数', () => {
    const first = addUsage(null, {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      totalTokens: 15,
      reasoning: 1,
      cost: { total: 0.01 },
    })
    const total = addUsage(first, {
      input: 20,
      output: 4,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 29,
      reasoning: 2,
      cost: { total: 0.02 },
    })
    const usage = piTokenUsage(total!)
    expect(usage.total).toMatchObject({ totalTokens: 44, outputTokens: 6 })
    expect((usage.total as { inputTokens: number }).inputTokens).toBe(38)
    expect(usage.estimatedCostUsd).toBeCloseTo(0.03)
  })

  it('get_messages 历史按用户消息切分 turns，并补全工具结果', () => {
    const history = messagesToThread(
      { id: 's1', cwd: '/work', preview: '列出当前目录' },
      [
        { role: 'system', content: '' },
        { role: 'user', content: [{ type: 'text', text: '列出当前目录' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '要用 bash' },
            { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
            { type: 'text', text: '完成' },
          ],
          usage: { input: 1, output: 1, totalTokens: 2 },
          stopReason: 'toolUse',
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'a.ts' }],
          isError: false,
        },
        { role: 'user', content: '谢谢' },
        { role: 'assistant', content: [{ type: 'text', text: '不客气' }], stopReason: 'stop' },
      ],
    )
    expect(history.turns).toHaveLength(2)
    const types = history.items.map((item) => item.type as string)
    expect(types).toContain('userMessage')
    expect(types).toContain('agentMessage')
    expect(types).toContain('reasoning')
    expect(types).toContain('commandExecution')
    const command = history.items.find((item) => item.type === 'commandExecution')
    expect(command).toMatchObject({ status: 'completed', aggregatedOutput: 'a.ts', exitCode: 0 })
    expect((history.thread.turns as unknown[])).toHaveLength(2)
    expect(history.thread).toMatchObject({ modelProvider: 'pi', cliVersion: 'pi-rpc' })
  })

  it('piThread 不冒充 codex/claude 的归属字段', () => {
    const thread = piThread({ id: 's1', cwd: '/work' })
    expect(thread).toMatchObject({
      id: 's1',
      cwd: '/work',
      modelProvider: 'pi',
      cliVersion: 'pi-rpc',
      originator: 'qingcode-next',
    })
    expect(thread.source).toEqual({ custom: 'pi-rpc' })
  })
})
