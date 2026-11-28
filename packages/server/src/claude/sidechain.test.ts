import { describe, expect, it } from 'vitest'
import { sessionMessagesToThread } from './history'
import { emptyMapState, mapSdkMessage, nextTurnState, type MapState } from './items'
import { sidechainItemId, withActivity } from './sidechain'
import type { Json, V2Notification } from './v2'

const assistant = (parent: string | null, ...content: Json[]): Json => ({
  type: 'assistant', parent_tool_use_id: parent, message: { id: `m-${content[0]?.id ?? 'text'}`, role: 'assistant', content },
})
const results = (parent: string | null, id: string, content = 'ok', isError = false): Json => ({
  type: 'user', parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
})
const call = (id: string, name: string, input: Json = {}): Json => ({ type: 'tool_use', id, name, input })

function feed(state: MapState, turnId: string, messages: Json[]) {
  const notifications: V2Notification[] = []
  for (const message of messages) {
    const mapped = mapSdkMessage(message, { threadId: 'thread', turnId, cwd: '/work' }, state)
    state = mapped.state
    notifications.push(...mapped.notifications)
  }
  return { state, notifications }
}

describe('Claude 子代理内部消息', () => {
  it('内部调用记入所属卡片，不产生主对话条目', () => {
    const { state, notifications } = feed(emptyMapState(), 'turn', [
      assistant(null, call('agent', 'Agent', { description: '检查' })),
      { type: 'stream_event', parent_tool_use_id: 'agent', event: { type: 'message_start', message: { id: 'child' } } },
      { type: 'user', parent_tool_use_id: 'agent', message: { role: 'user', content: [{ type: 'text', text: '委派提示' }] } },
      assistant('agent', { type: 'text', text: '子代理的话' }),
      assistant('agent', call('read', 'Read', { file_path: '/work/a.ts' })),
      results('agent', 'read'),
      assistant('agent', call('inner', 'Agent', { description: '再检查' })),
      assistant('inner', call('bash', 'Bash', { command: 'pnpm test' })),
      results('inner', 'bash', '失败', true),
      results('agent', 'inner'),
      results(null, 'agent', '报告'),
    ])
    expect(state.order).toHaveLength(1)
    expect(state.messageId).toBeNull()
    expect(state.items[state.order[0]!]).toMatchObject({
      type: 'dynamicToolCall', tool: 'Agent', toolUseId: 'agent', status: 'completed',
      activity: [
        { id: 'read', tool: 'Read', summary: '/work/a.ts', status: 'completed' },
        { id: 'inner', tool: 'Agent', summary: '再检查', status: 'completed' },
        { id: 'bash', tool: 'Bash', summary: 'pnpm test', status: 'failed' },
      ],
    })
    expect(new Set(notifications.map((note) => note.params.itemId)).size).toBe(1)
    expect(sidechainItemId(state.sidechains, 'bash')).toBe(state.order[0])
    expect(sidechainItemId(state.sidechains, 'agent')).toBe('')
  })

  it('后台子代理在后续轮次的调用仍归到原轮次，结束通知收尾活动', () => {
    const first = feed(emptyMapState(), 'first', [
      assistant(null, call('agent', 'Task')),
      results(null, 'agent', 'async_launched'),
    ])
    const later = feed(nextTurnState(first.state), 'second', [
      assistant('agent', call('grep', 'Grep', { pattern: 'TODO' })),
      { type: 'system', subtype: 'task_notification', task_id: 't', tool_use_id: 'agent', status: 'stopped', summary: '已停止' },
    ])
    const cards = later.notifications.filter((note) => (note.params.item as Json).type === 'dynamicToolCall')
    expect(cards.map((note) => [note.method, note.params.turnId, (note.params.item as { activity: Json[] }).activity[0]?.status]))
      .toEqual([['item/completed', 'first', 'inProgress'], ['item/completed', 'first', 'failed']])
    expect(later.state.order.some((id) => later.state.items[id]?.type === 'dynamicToolCall')).toBe(false)
  })

  it('轮次中断时卡片与未完成的活动一起收尾', () => {
    const { state } = feed(emptyMapState(), 'turn', [
      assistant(null, call('agent', 'Agent')),
      assistant('agent', call('read', 'Read')),
      { type: 'result', subtype: 'error_during_execution' },
    ])
    expect(state.items[state.order[0]!]).toMatchObject({ status: 'completed', activity: [{ status: 'completed' }] })
  })

  it('找不到归属的内部消息直接丢弃', () => {
    const { state, notifications } = feed(emptyMapState(), 'turn', [assistant('unknown', call('read', 'Read'))])
    expect(state.order).toEqual([])
    expect(notifications).toEqual([])
  })

  it('历史忽略内部消息开轮，并能补回本进程记下的活动', () => {
    const entry = (uuid: string, message: Json) =>
      ({ uuid, parent_tool_use_id: message.parent_tool_use_id, message: message.message })
    const history = sessionMessagesToThread({ id: 's', cwd: '/work' }, [
      { uuid: 'u1', message: { role: 'user', content: '开始' } },
      entry('a1', assistant(null, call('agent', 'Agent'))),
      { uuid: 'c1', parent_tool_use_id: 'agent', message: { role: 'user', content: '委派提示' } },
      entry('r1', results(null, 'agent')),
    ])
    expect(history.turns).toHaveLength(1)
    expect(history.turns[0]?.items).toHaveLength(2)
    const live = feed(emptyMapState(), 'turn', [
      assistant(null, call('agent', 'Agent')),
      assistant('agent', call('read', 'Read')),
    ])
    const [turn] = withActivity(history.turns, live.state.sidechains)
    expect((turn?.items as Json[])[1]).toMatchObject({ toolUseId: 'agent', activity: [{ id: 'read' }] })
  })
})
