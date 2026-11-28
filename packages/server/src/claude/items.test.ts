import { describe, expect, it } from 'vitest'
import {
  emptyMapState,
  fileChangesFromTool,
  finishPendingItems,
  mapSdkMessage,
  toolResultText,
  toolUseItem,
  unifiedDiff,
} from './items'
import type { Json, MapContext, V2Notification } from './v2'

const ctx: MapContext = { threadId: 'thread-1', turnId: 'turn-1', cwd: '/work', now: 1000 }

function notes(message: unknown, state = emptyMapState(), options = {}): V2Notification[] {
  return mapSdkMessage(message, ctx, state, options).notifications
}

function methods(list: V2Notification[]): string[] {
  return list.map((note) => note.method)
}

function streamEvent(type: string, extra: Json): Json {
  return { type: 'stream_event', event: { type, ...extra }, session_id: 'thread-1' }
}

describe('SDK 流式事件 → v2 item', () => {
  it('message_start 固定 messageId，文本增量映射为 agentMessage/delta 并复用同一 itemId', () => {
    let state = emptyMapState()
    let result = mapSdkMessage(streamEvent('message_start', { message: { id: 'msg-1' } }), ctx, state)
    state = result.state
    result = mapSdkMessage(
      streamEvent('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      ctx,
      state,
    )
    expect(methods(result.notifications)).toEqual(['item/started'])
    state = result.state
    result = mapSdkMessage(
      streamEvent('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: '你好' },
      }),
      ctx,
      state,
    )
    const delta = result.notifications[0]
    expect(delta?.method).toBe('item/agentMessage/delta')
    expect(delta?.params.delta).toBe('你好')
    expect(delta?.params.threadId).toBe('thread-1')
    expect(delta?.params.turnId).toBe('turn-1')
    const itemId = delta?.params.itemId
    state = result.state
    result = mapSdkMessage(streamEvent('content_block_stop', { index: 0 }), ctx, state)
    expect(methods(result.notifications)).toEqual(['item/completed'])
    expect((result.notifications[0]?.params.item as Json).text).toBe('你好')
    expect((result.notifications[0]?.params.item as Json).id).toBe(itemId)
  })

  it('流式块与完整 assistant 消息描述同一块时 started/completed 各只发一次（两种先后顺序）', () => {
    const run = (assistantFirst: boolean): string[] => {
      let state = emptyMapState()
      const all: string[] = []
      const feed = (msg: Json): void => {
        const r = mapSdkMessage(msg, ctx, state)
        state = r.state
        all.push(...methods(r.notifications))
      }
      const assistant = { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: '你好' }] }, session_id: 'thread-1' }
      feed(streamEvent('message_start', { message: { id: 'msg-1' } }))
      feed(streamEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }))
      feed(streamEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好' } }))
      if (assistantFirst) feed(assistant)
      feed(streamEvent('content_block_stop', { index: 0 }))
      if (!assistantFirst) feed(assistant)
      return all
    }
    expect(run(true)).toEqual(['item/started', 'item/agentMessage/delta', 'item/completed'])
    expect(run(false)).toEqual(['item/started', 'item/agentMessage/delta', 'item/completed'])
  })

  it('SDK 把思考与文本拆成两条 assistant 消息（下标都为 0）时，按类型对应各自的流式块', () => {
    let state = emptyMapState()
    const notes: Array<{ method: string; id: unknown; type: unknown }> = []
    const feed = (msg: Json): void => {
      const r = mapSdkMessage(msg, ctx, state)
      state = r.state
      for (const n of r.notifications) {
        const item = n.params.item as Json | undefined
        notes.push({ method: n.method, id: n.params.itemId, type: item?.type })
      }
    }
    const assistant = (block: Json): Json => ({ type: 'assistant', message: { id: 'msg-2', content: [block] }, session_id: 'thread-1' })
    feed(streamEvent('message_start', { message: { id: 'msg-2' } }))
    feed(streamEvent('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }))
    feed(streamEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '想' } }))
    feed(assistant({ type: 'thinking', thinking: '想' }))
    feed(streamEvent('content_block_stop', { index: 0 }))
    feed(streamEvent('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }))
    feed(streamEvent('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '答' } }))
    feed(assistant({ type: 'text', text: '答' }))
    feed(streamEvent('content_block_stop', { index: 1 }))
    const lifecycle = notes.filter((n) => n.method === 'item/started' || n.method === 'item/completed')
    expect(lifecycle.map((n) => `${n.method}:${String(n.type)}`)).toEqual([
      'item/started:reasoning',
      'item/completed:reasoning',
      'item/started:agentMessage',
      'item/completed:agentMessage',
    ])
    expect(lifecycle[0]?.id).toBe(lifecycle[1]?.id)
    expect(lifecycle[2]?.id).toBe(lifecycle[3]?.id)
    expect(lifecycle[0]?.id).not.toBe(lifecycle[2]?.id)
  })

  it('thinking 增量映射为 reasoning/summaryTextDelta', () => {
    const state = emptyMapState()
    const mapped = mapSdkMessage(
      streamEvent('content_block_delta', {
        index: 1,
        delta: { type: 'thinking_delta', thinking: '先想一想' },
      }),
      ctx,
      state,
    )
    expect(mapped.notifications[0]).toEqual({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: expect.any(String),
        delta: '先想一想',
        summaryIndex: 0,
      },
    })
    expect(mapped.state.blockKinds[mapped.notifications[0]?.params.itemId as string]).toBe(
      'thinking',
    )
  })

  it('签名 / 工具参数增量不产生多余通知', () => {
    expect(
      notes(
        streamEvent('content_block_delta', {
          index: 0,
          delta: { type: 'signature_delta', signature: 'x' },
        }),
      ),
    ).toEqual([])
    expect(
      notes(
        streamEvent('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        }),
      ),
    ).toEqual([])
  })
})

describe('assistant / user 完整消息 → v2 item', () => {
  it('text 与 thinking 内容块各发 started + completed，且与流事件共用 itemId', () => {
    const message = {
      type: 'assistant',
      message: {
        id: 'msg-2',
        role: 'assistant',
        content: [
          { type: 'text', text: '最终答案' },
          { type: 'thinking', thinking: '推理过程' },
        ],
      },
    }
    const mapped = notes(message)
    expect(methods(mapped)).toEqual([
      'item/started',
      'item/completed',
      'item/started',
      'item/completed',
    ])
    expect((mapped[0]?.params.item as Json).type).toBe('agentMessage')
    expect((mapped[1]?.params.item as Json).text).toBe('最终答案')
    expect((mapped[2]?.params.item as Json).type).toBe('reasoning')
    expect((mapped[3]?.params.item as Json).summary).toEqual(['推理过程'])
  })

  it('Bash tool_use → commandExecution，tool_result → completed 带输出与退出码', () => {
    let state = emptyMapState()
    const started = mapSdkMessage(
      {
        type: 'assistant',
        message: {
          id: 'msg-3',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'Bash',
              input: { command: 'echo qn-ok', cwd: '/work' },
            },
          ],
        },
      },
      ctx,
      state,
    )
    state = started.state
    expect(methods(started.notifications)).toEqual(['item/started'])
    const item = started.notifications[0]?.params.item as Json
    expect(item.type).toBe('commandExecution')
    expect(item.command).toBe('echo qn-ok')
    expect(item.cwd).toBe('/work')
    expect(item.status).toBe('inProgress')

    const completed = mapSdkMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: 'qn-ok',
              is_error: false,
            },
          ],
        },
      },
      ctx,
      state,
    )
    expect(methods(completed.notifications)).toEqual(['item/completed'])
    const done = completed.notifications[0]?.params.item as Json
    expect(done.id).toBe(item.id)
    expect(done.aggregatedOutput).toBe('qn-ok')
    expect(done.exitCode).toBe(0)
    expect(done.status).toBe('completed')
  })

  it('tool_result.is_error 让命令变成 failed / 退出码 1', () => {
    const result = mapSdkMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'boom', is_error: true }],
        },
      },
      ctx,
      emptyMapState(),
    )
    const item = result.notifications[0]?.params.item as Json
    expect(item.status).toBe('failed')
    expect(item.success).toBe(false)
  })

  it('未知工具 → dynamicToolCall，mcp 工具 → mcpToolCall，都带工具名与参数摘要', () => {
    const other = toolUseItem('i1', 'Read', { file_path: '/work/a.ts' }, '/work')
    expect(other.type).toBe('dynamicToolCall')
    expect(other.tool).toBe('Read')
    expect(String(other.summary)).toContain('Read')
    const mcp = toolUseItem('i2', 'mcp__demo__lookup', { q: 1 }, '/work')
    expect(mcp.type).toBe('mcpToolCall')
    expect(mcp.server).toBe('demo')
    expect(mcp.tool).toBe('lookup')
  })

  it.each(['Agent', 'Task'])('标记 Claude 的 %s 子代理委派', (name) => {
    const options = { description: '检查文档', subagent_type: 'general-purpose' }
    expect(toolUseItem('i1', name, options, '/work')).toMatchObject({
      type: 'dynamicToolCall', namespace: 'claude', tool: name, arguments: options, status: 'inProgress',
    })
  })

  it('历史回放才生成 userMessage，实时流忽略普通用户文本', () => {
    const user = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '请回答' }] },
    }
    expect(notes(user)).toEqual([])
    expect(methods(notes(user, emptyMapState(), { includeUserText: true }))).toEqual([
      'item/started',
      'item/completed',
    ])
  })
})

describe('文件改动 diff', () => {
  it('Write / Edit / MultiEdit / NotebookEdit 生成统一 diff 与路径', () => {
    const write = fileChangesFromTool('Write', { file_path: 'a.ts', content: 'hello\n' })
    expect(write[0]).toMatchObject({ path: 'a.ts', kind: { type: 'add' } })
    expect(String(write[0]?.diff)).toContain('+hello')

    const edit = fileChangesFromTool('Edit', {
      file_path: 'b.ts',
      old_string: 'old',
      new_string: 'new',
    })
    expect(edit[0]).toMatchObject({ path: 'b.ts', kind: { type: 'update', move_path: null } })
    expect(String(edit[0]?.diff)).toContain('-old')
    expect(String(edit[0]?.diff)).toContain('+new')

    const multi = fileChangesFromTool('MultiEdit', {
      file_path: 'c.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    })
    expect(String(multi[0]?.diff)).toContain('+d')

    const notebook = fileChangesFromTool('NotebookEdit', {
      notebook_path: 'n.ipynb',
      new_source: 'cell',
    })
    expect(notebook[0]?.path).toBe('n.ipynb')
  })

  it('unifiedDiff 不因空内容抛错；toolResultText 支持字符串与块数组', () => {
    expect(unifiedDiff('x', '', '')).toContain('--- a/x')
    expect(toolResultText('ok')).toBe('ok')
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })
})

describe('result / rate_limit_event / turn 收尾', () => {
  it('success → turn/completed completed + tokenUsage（含成本估算）', () => {
    const mapped = notes({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1234,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
      total_cost_usd: 0.012,
      result: '你好',
    })
    expect(methods(mapped)).toEqual(['turn/completed', 'thread/tokenUsage/updated'])
    const turn = mapped[0]?.params.turn as Json
    expect(turn.status).toBe('completed')
    expect(turn.id).toBe('turn-1')
    expect(turn.durationMs).toBe(1234)
    const usage = mapped[1]?.params.tokenUsage as Json
    expect((usage.total as Json).totalTokens).toBe(17)
    expect(usage.estimatedCostUsd).toBe(0.012)
    expect(usage.estimated).toBe(true)
  })

  it('每次主代理调用实时上报上下文占用，result 带上窗口并跨轮保留', () => {
    const usage = (total: number) => ({ input_tokens: total - 100, output_tokens: 100, cache_read_input_tokens: 0 })
    const assistant = (total: number, extra: Json = {}) => ({
      type: 'assistant', message: { id: `msg-${total}`, content: [], usage: usage(total) }, ...extra,
    })
    let state = emptyMapState()
    let result = mapSdkMessage(assistant(1000), ctx, state)
    const live = result.notifications.find((note) => note.method === 'thread/tokenUsage/updated')?.params.tokenUsage as Json
    expect((live.last as Json).totalTokens).toBe(1000)
    expect(live.modelContextWindow).toBeNull()
    state = result.state
    // 子代理的调用和重复计数都不上报。
    expect(methods(mapSdkMessage(assistant(5000, { parent_tool_use_id: 'tool-1' }), ctx, state).notifications)).toEqual([])
    expect(methods(mapSdkMessage(assistant(1000), ctx, state).notifications)).toEqual([])
    result = mapSdkMessage({
      type: 'result', subtype: 'success', usage: usage(9000), total_cost_usd: 0.1,
      modelUsage: { 'claude-haiku': { contextWindow: 100_000 }, 'claude-opus': { contextWindow: 200_000 } },
    }, ctx, state)
    const final = result.notifications.at(-1)?.params.tokenUsage as Json
    expect((final.last as Json).totalTokens).toBe(1000)
    expect((final.total as Json).totalTokens).toBe(9000)
    expect(final.modelContextWindow).toBe(200_000)
    const next = mapSdkMessage(assistant(2000), ctx, emptyMapState(undefined, result.state.contextWindow)).notifications
    expect((next[0]?.params.tokenUsage as Json).modelContextWindow).toBe(200_000)
  })

  it('error_during_execution → interrupted，其他 error → failed + error.message', () => {
    const interrupted = notes({ type: 'result', subtype: 'error_during_execution', errors: [] })
    expect((interrupted[0]?.params.turn as Json).status).toBe('interrupted')
    const failed = notes({
      type: 'result',
      subtype: 'error_max_turns',
      errors: ['达到最大轮次'],
      usage: {},
    })
    expect((failed[0]?.params.turn as Json).status).toBe('failed')
    expect(((failed[0]?.params.turn as Json).error as Json).message).toBe('达到最大轮次')
  })

  it('rate_limit_event → account/rateLimits/updated 的 primary 利用率与重置时间', () => {
    const mapped = notes({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.9,
        resetsAt: 1_800_000_000,
      },
    })
    expect(methods(mapped)).toEqual(['account/rateLimits/updated'])
    const snapshot = mapped[0]?.params.rateLimits as Json
    expect(snapshot.primary).toEqual({
      usedPercent: 90,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000,
    })
  })

  it('finishPendingItems 把仍在 inProgress 的 item 收尾，且不修改传入 state', () => {
    const state = emptyMapState()
    const started = mapSdkMessage(
      {
        type: 'assistant',
        message: {
          id: 'm',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'sleep 1' } },
          ],
        },
      },
      ctx,
      state,
    )
    expect(state.order).toEqual([])
    const finished = finishPendingItems(ctx, started.state, true)
    expect(finished).toHaveLength(1)
    expect((finished[0]?.params.item as Json).status).toBe('failed')
  })

  it('没有结果的 ExitPlanMode 收尾时记为 failed，不让客户端当成已批准', () => {
    const started = mapSdkMessage(
      {
        type: 'assistant',
        message: {
          id: 'm',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'plan', name: 'ExitPlanMode', input: { plan: '步骤' } }],
        },
      },
      ctx,
      emptyMapState(),
    )
    const finished = finishPendingItems(ctx, started.state, false)
    expect(finished).toHaveLength(1)
    expect((finished[0]?.params.item as Json).status).toBe('failed')
  })
})

describe('纯函数杂项', () => {
  it('无法识别的消息返回空通知且保持 state 引用不变', () => {
    const state = emptyMapState()
    const mapped = mapSdkMessage(null, ctx, state)
    expect(mapped.notifications).toEqual([])
    expect(mapped.state).not.toBe(state)
    expect(state.nextItem).toBe(0)
  })
})
