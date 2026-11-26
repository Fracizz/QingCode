import { describe, expect, it } from 'vitest'
import {
  msToSeconds,
  sessionInfoToMeta,
  sessionMessagesToThread,
  threadListResponse,
} from './history'
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
      ],
      '/fallback',
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

  it('非法条目被跳过', () => {
    expect(sessionMessagesToThread(meta, [null, 1, 'x', {}]).items).toEqual([])
  })
})
