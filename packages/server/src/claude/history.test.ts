import { describe, expect, it } from 'vitest'
import {
  msToSeconds,
  sessionInfoToMeta,
  sessionMessagesToThread,
  threadListResponse, lastContextUsage, lastReplyModel } from './history'
import type { Json, SessionMeta } from './v2'

const meta: SessionMeta = { id: 'sess-1', cwd: '/work', createdAt: 100, updatedAt: 200 }

function sessionMessage(role: string, content: unknown, id = 'msg'): Json {
  return {
    type: role,
    uuid: `${id}-uuid`,
    session_id: 'sess-1',
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      id,
      role,
      content,
    },
  }
}

describe('SDKSessionInfo → Thread 元数据', () => {
  it('毫秒时间戳换算成秒，summary/firstPrompt/customTitle 落位', () => {
    expect(msToSeconds(1_700_000_000_000)).toBe(1_700_000_000)
    expect(msToSeconds(undefined)).toBeUndefined()
    const converted = sessionInfoToMeta(
      {
        sessionId: 'abc',
        summary: '摘要',
        firstPrompt: '第一个问题',
        customTitle: '自定义标题',
        cwd: '/project',
        lastModified: 1_700_000_000_000,
        createdAt: 1_600_000_000_000,
      },
      '/fallback',
    )
    expect(converted).toEqual({
      id: 'abc',
      cwd: '/project',
      preview: '摘要',
      name: '自定义标题',
      createdAt: 1_600_000_000,
      updatedAt: 1_700_000_000,
    })
  })

  it('thread/list 响应按 lastModified 降序，且不含无 id 的条目', () => {
    const response = threadListResponse(
      [
        { sessionId: 'a', summary: 'A', lastModified: 1_000 },
        { sessionId: 'b', summary: 'B', lastModified: 3_000 },
        { summary: '无 id', lastModified: 4_000 },
      ].map((info) => sessionInfoToMeta(info, '/fallback')),
    )
    expect(response.nextCursor).toBeNull()
    const data = response.data as Json[]
    expect(data.map((thread) => thread.id)).toEqual(['b', 'a'])
    expect(data[0]?.cwd).toBe('/fallback')
    expect(data[0]?.status).toEqual({ type: 'idle' })
    expect(data[0]?.turns).toEqual([])
  })
})

describe('getSessionMessages → v2 Thread/turns/items', () => {
  it('按用户文本切分两个 turn，工具结果与回复归属正确的 turn', () => {
    const messages = [
      sessionMessage('user', [{ type: 'text', text: '第一问' }], 'm1'),
      sessionMessage(
        'assistant',
        [
          { type: 'thinking', thinking: '推理' },
          { type: 'text', text: '第一答' },
        ],
        'm2',
      ),
      sessionMessage(
        'user',
        [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'qn-ok' }],
        'm3',
      ),
      sessionMessage('user', [{ type: 'text', text: '第二问' }], 'm4'),
      sessionMessage(
        'assistant',
        [
          {
            type: 'tool_use',
            id: 'tu-2',
            name: 'Bash',
            input: { command: 'echo hi' },
          },
        ],
        'm5',
      ),
      sessionMessage(
        'user',
        [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'hi' }],
        'm6',
      ),
    ]
    const result = sessionMessagesToThread(meta, messages)
    const thread = result.thread
    expect(thread.id).toBe('sess-1')
    expect(thread.cwd).toBe('/work')
    expect(thread.createdAt).toBe(100)
    expect(result.turns).toHaveLength(2)

    const first = result.turns[0] as Json
    const second = result.turns[1] as Json
    expect(first.status).toBe('completed')
    const firstTypes = (first.items as Json[]).map((item) => item.type)
    expect(firstTypes).toContain('userMessage')
    expect(firstTypes).toContain('agentMessage')
    expect(firstTypes).toContain('reasoning')
    expect(firstTypes).not.toContain('commandExecution')
    const secondTypes = (second.items as Json[]).map((item) => item.type)
    expect(secondTypes).toContain('userMessage')
    expect(secondTypes).toContain('commandExecution')
    const command = (second.items as Json[]).find((item) => item.type === 'commandExecution')
    expect(command?.status).toBe('completed')
    expect(command?.aggregatedOutput).toBe('hi')
    expect((thread.turns as Json[])).toHaveLength(2)
  })

  it('Claude Code 写入的 API 失败消息把该轮标为 failed，之后成功的轮次不受影响', () => {
    const failure = sessionMessage('assistant', [{ type: 'text', text: 'API Error: Request rejected (429) · limit' }], 'e1')
    ;(failure.message as Json).model = '<synthetic>'
    const result = sessionMessagesToThread(meta, [
      sessionMessage('user', [{ type: 'text', text: '你好' }], 'u1'),
      failure,
      sessionMessage('user', [{ type: 'text', text: '再试' }], 'u2'),
      sessionMessage('assistant', [{ type: 'text', text: 'ok' }], 'a2'),
    ])
    expect(result.turns[0]).toMatchObject({ status: 'failed', error: { message: 'API Error: Request rejected (429) · limit' } })
    expect(result.turns[1]).toMatchObject({ status: 'completed', error: null })
  })

  it('中断占位记录不当作用户输入，所在轮次标为 interrupted', () => {
    const result = sessionMessagesToThread(meta, [
      sessionMessage('user', [{ type: 'text', text: '跑测试' }], 'u1'),
      sessionMessage('assistant', [{ type: 'text', text: '开始' }], 'a1'),
      sessionMessage('user', [{ type: 'text', text: '[Request interrupted by user]' }], 'i1'),
      sessionMessage('user', [{ type: 'text', text: '继续' }], 'u2'),
      sessionMessage('user', [{ type: 'text', text: '[Request interrupted by user for tool use]' }], 'i2'),
      sessionMessage('user', [{ type: 'text', text: '[Request interrupted by user] 是什么' }], 'u3'),
    ])
    expect(result.turns.map((turn) => turn.status)).toEqual(['interrupted', 'interrupted', 'completed'])
    expect(result.items.map((item) => item.id)).not.toContain('i1-uuid')
    expect(result.items.map((item) => item.id)).not.toContain('i2-uuid')
    expect(result.items.filter((item) => item.type === 'userMessage')).toHaveLength(3)
    expect(result.forkPoints[0]!.lastMessageId).toBe('i1-uuid')
  })

  it('系统写入的记录不显示成用户气泡，也不单独开启轮次', () => {
    const injected = (uuid: string, content: string, extra: Json) => ({ ...sessionMessage('user', content, uuid), ...extra })
    const task = { origin: { kind: 'task-notification' } }
    const result = sessionMessagesToThread(meta, [
      sessionMessage('user', [{ type: 'text', text: '开始' }], 'u1'),
      injected('p1', 'Another Claude session sent a message:\n<agent-message from="a1">原文</agent-message>',
        { origin: { kind: 'peer', name: 'web-fetch', body: '说明 + 报告', handbackReportText: '报告' } }),
      injected('p2', '<cross-session-message from="x">你好</cross-session-message>', { origin: { kind: 'peer' } }),
      injected('c1', 'This session is being continued…', { isCompactSummary: true }),
      injected('t1', '<task-notification>\n<task-id>a</task-id>\n<status>completed</status>\n<summary>子代理</summary>\n'
        + '<result>引用 <usage> 标签</result>\n<usage><tool_uses>1</tool_uses></usage>\n</task-notification>', task),
      injected('t2', '<task-notification>\n<task-id>m</task-id>\n<summary>监视</summary>\n<event>ready</event>\n</task-notification>', task),
      injected('t3', '<task-notification>\n<task-id>k</task-id>\n<status>killed</status>\n<summary>终止</summary>\n</task-notification>', task),
      injected('f1', '<task-notification>\n<fork-source>分叉说明</fork-source>\n</task-notification>', task),
    ])
    expect(result.turns).toHaveLength(1)
    expect(result.items).toMatchObject([
      { type: 'userMessage' },
      { type: 'backgroundTaskNotification', status: 'message', summary: 'web-fetch', result: '报告' },
      { type: 'backgroundTaskNotification', status: 'message', summary: '', result: '你好' },
      { type: 'contextCompaction', status: 'completed' },
      { type: 'backgroundTaskNotification', status: 'completed', summary: '子代理', result: '引用 <usage> 标签' },
      { type: 'backgroundTaskNotification', status: 'event', summary: '监视', result: 'ready' },
      { type: 'backgroundTaskNotification', status: 'stopped', summary: '终止' },
    ])
    expect(result.items).toHaveLength(7)
  })

  it('中断后写入的消息另起一轮，中断状态不后移', () => {
    const result = sessionMessagesToThread(meta, [
      sessionMessage('user', [{ type: 'text', text: '开始' }], 'u1'),
      sessionMessage('user', [{ type: 'text', text: '[Request interrupted by user]' }], 'i1'),
      { ...sessionMessage('user', '消息', 'p1'), origin: { kind: 'peer', body: '消息' } },
      sessionMessage('assistant', [{ type: 'text', text: '收到' }], 'a1'),
    ])
    expect(result.turns.map((turn) => turn.status)).toEqual(['interrupted', 'completed'])
  })

  it('粘贴内容去掉包装标签，! 命令还原成命令与代码块输出', () => {
    const result = sessionMessagesToThread(meta, [
      sessionMessage('user', '看看\n<pasted_content id="4a">\n第一行\n第二行\n</pasted_content id="4a">', 'u1'),
      sessionMessage('user', '<bash-input>echo hi</bash-input>', 'b1'),
      sessionMessage('user', '<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>', 'b2'),
      sessionMessage('user', '<bash-input> 是什么标签？', 'u2'),
    ])
    const texts = result.items.map((item) => item.type === 'agentMessage' ? item.text : ((item.content as Json[])[0] as Json).text)
    expect(texts).toEqual(['看看\n第一行\n第二行', '!echo hi', '```\nhi\n```', '<bash-input> 是什么标签？'])
  })

  it('终端本地斜杠命令：命令显示为用户输入，输出作为同一轮回复，说明记录略过', () => {
    const result = sessionMessagesToThread(meta, [
      sessionMessage('user', '<local-command-caveat>Caveat: ignore</local-command-caveat>', 'c0'),
      sessionMessage('user', '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>', 'c1'),
      sessionMessage('user', '<local-command-stdout>Set model to sonnet</local-command-stdout>', 'c2'),
      sessionMessage('user', [{ type: 'text', text: '继续' }], 'u1'),
    ])
    expect(result.turns).toHaveLength(2)
    const items = (result.turns[0] as Json).items as Json[]
    expect(items.map((item) => item.type)).toEqual(['userMessage', 'agentMessage'])
    expect(((items[0]!.content as Json[])[0] as Json).text).toBe('/model sonnet')
    expect(items[1]!.text).toBe('Set model to sonnet')
  })

  it('没有用户文本时所有消息归为一个 turn；空历史返回空 turns', () => {
    const result = sessionMessagesToThread(meta, [
      sessionMessage('assistant', [{ type: 'text', text: '孤立回复' }], 'm1'),
    ])
    expect(result.turns).toHaveLength(1)
    expect(((result.turns[0] as Json).items as Json[])[0]?.text).toBe('孤立回复')
    expect(sessionMessagesToThread(meta, []).turns).toEqual([])
  })

  it('带图片的用户消息合并为单个 userMessage，base64 还原成 data URL，url 源原样给出', () => {
    const result = sessionMessagesToThread(meta, [
      sessionMessage(
        'user',
        [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
          { type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } },
          { type: 'text', text: '看图' },
        ],
        'u1',
      ),
      sessionMessage('assistant', [{ type: 'text', text: '好' }], 'a1'),
    ])
    expect(result.turns).toHaveLength(1)
    const users = (result.items as Json[]).filter((item) => item.type === 'userMessage')
    expect(users).toHaveLength(1)
    expect(users[0]?.content).toEqual([
      { type: 'image', url: 'data:image/png;base64,QUJD' },
      { type: 'image', url: 'https://x.test/a.png' },
      { type: 'text', text: '看图', text_elements: [] },
    ])
  })

  it('只有图片没有文字的用户消息同样开启新 turn', () => {
    const result = sessionMessagesToThread(meta, [
      sessionMessage('user', [{ type: 'text', text: '先问' }], 'u0'),
      sessionMessage('assistant', [{ type: 'text', text: '答' }], 'a0'),
      sessionMessage(
        'user',
        [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QQ==' } }],
        'u1',
      ),
    ])
    expect(result.turns).toHaveLength(2)
  })

  it('thread/read 的历史线程带上当前模型/推理强度', () => {
    const result = sessionMessagesToThread(meta, [], { model: 'opus', reasoningEffort: 'max' })
    expect(result.thread).toMatchObject({ model: 'opus', reasoningEffort: 'max' })
  })

  it('非法条目被跳过', () => {
    expect(sessionMessagesToThread(meta, [null, 1, 'x', {}]).items).toEqual([])
  })
})

describe('lastReplyModel', () => {
  it('取主会话最近一条真实回复的模型，跳过子 agent 与 synthetic 占位', () => {
    expect(lastReplyModel([
      { message: { role: 'assistant', model: 'claude-sonnet-5-5' } },
      { message: { role: 'user', content: 'x' } },
      { message: { role: 'assistant', model: 'claude-haiku-5' }, parent_tool_use_id: 'tool-1' },
      { message: { role: 'assistant', model: 'claude-haiku-5' }, isSidechain: true },
      { message: { role: 'assistant', model: '<synthetic>' } },
    ])).toBe('claude-sonnet-5-5')
    expect(lastReplyModel([{ message: { role: 'user', content: 'x' } }])).toBeNull()
  })
})

describe('lastContextUsage', () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 20 }

  it('取主会话最近一次回复的 usage 作为当前上下文占用', () => {
    expect(lastContextUsage([
      { message: { role: 'assistant', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 1 } } },
      { message: { role: 'assistant', model: 'claude-sonnet-5-5', usage } },
      { message: { role: 'assistant', model: 'claude-haiku-5', usage: { input_tokens: 9 } }, parent_tool_use_id: 'tool-1' },
      { message: { role: 'assistant', model: '<synthetic>', usage: { input_tokens: 0 } } },
      { message: { role: 'user', content: 'x' } },
    ])).toMatchObject({ totalTokens: 135, inputTokens: 115, outputTokens: 20 })
  })

  it('最近一次回复之后发生过压缩时不给读数', () => {
    expect(lastContextUsage([
      { message: { role: 'assistant', model: 'claude-sonnet-5-5', usage } },
      { isCompactSummary: true, message: { role: 'user', content: 'summary' } },
    ])).toBeNull()
    expect(lastContextUsage([{ message: { role: 'user', content: 'x' } }])).toBeNull()
  })
})
