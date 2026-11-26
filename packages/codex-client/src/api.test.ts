import { describe, expect, it } from 'vitest'
import {
  interruptTurn,
  listModels,
  listSkills,
  listThreads,
  readSubagentThread,
  readThread,
  resumeThread,
  sendText,
  startThread,
} from './api'
import type { CodexRpcLike } from './api'
import { CodexRpcError } from './rpc'

type Call = { method: string; params: unknown }

function fakeRpc(): { rpc: CodexRpcLike; calls: Call[] } {
  const calls: Call[] = []
  const rpc = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params })
      return { ok: true }
    },
  } as unknown as CodexRpcLike
  return { rpc, calls }
}

describe('codex api', () => {
  it('构造线程与对话请求参数', async () => {
    const { rpc, calls } = fakeRpc()

    await listThreads(rpc, '/repo')
    await listThreads(rpc)
    await startThread(rpc, { cwd: '/repo' })
    await resumeThread(rpc, 'thread-1')
    await readThread(rpc, 'thread-1')
    await sendText(rpc, 'thread-1', '你好')
    await sendText(rpc, 'thread-1', '继续', { model: 'gpt-x', effort: 'high', serviceTier: null })
    await interruptTurn(rpc, 'thread-1', 'turn-1')

    expect(calls).toEqual([
      { method: 'thread/list', params: { cwd: '/repo', sortKey: 'updated_at' } },
      { method: 'thread/list', params: { sortKey: 'updated_at' } },
      { method: 'thread/start', params: { cwd: '/repo' } },
      { method: 'thread/resume', params: { threadId: 'thread-1' } },
      { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          input: [{ type: 'text', text: '你好', text_elements: [] }],
        },
      },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          input: [{ type: 'text', text: '继续', text_elements: [] }],
          model: 'gpt-x',
          effort: 'high',
          serviceTier: null,
        },
      },
      { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } },
    ])
  })

  it('跨页列出历史，保留项目过滤并去除重叠的会话', async () => {
    const calls: unknown[] = []
    const rpc = {
      request: async (_method: string, params: { cursor?: string }) => {
        calls.push(params)
        return params.cursor
          ? { data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nextCursor: null }
          : { data: [{ id: 'a' }], nextCursor: 'p2' }
      },
    } as CodexRpcLike

    const { data } = await listThreads(rpc, ['/repo', '/other'], 2)
    expect(data.map((thread) => thread.id)).toEqual(['a', 'b'])
    expect(calls).toEqual([
      { cwd: ['/repo', '/other'], sortKey: 'updated_at', limit: 2 },
      { cwd: ['/repo', '/other'], sortKey: 'updated_at', limit: 1, cursor: 'p2' },
    ])
  })

  it('整份历史超限时缩小单页，按时间顺序恢复完整条目', async () => {
    const oversize = new CodexRpcError('会话数据超过传输大小上限', -32000, 'response_too_large')
    const calls: Call[] = []
    const rpc = {
      request: async (method: string, params: { excludeTurns?: boolean; limit?: number; cursor?: string }) => {
        calls.push({ method, params })
        if (method === 'thread/resume') {
          if (!params.excludeTurns) throw oversize
          return { thread: { id: 'long', turns: [] }, model: 'current' }
        }
        if (params.limit === 20) throw oversize
        const older = { id: 'older', items: [] }
        const newer = { id: 'newer', items: [{ id: 'reply', text: '完整内容' }] }
        return params.cursor
          ? { data: [older, newer], nextCursor: null }
          : { data: [older], nextCursor: 'newer-page' }
      },
    } as unknown as CodexRpcLike

    await expect(resumeThread(rpc, 'long')).resolves.toMatchObject({
      thread: { turns: [{ id: 'older' }, { id: 'newer', items: [{ text: '完整内容' }] }] },
      model: 'current',
    })
    expect(calls).toEqual([
      { method: 'thread/resume', params: { threadId: 'long' } },
      { method: 'thread/resume', params: { threadId: 'long', excludeTurns: true } },
      { method: 'thread/turns/list', params: { threadId: 'long', limit: 20, cursor: null, sortDirection: 'asc', itemsView: 'full' } },
      { method: 'thread/turns/list', params: { threadId: 'long', limit: 10, cursor: null, sortDirection: 'asc', itemsView: 'full' } },
      { method: 'thread/turns/list', params: { threadId: 'long', limit: 10, cursor: 'newer-page', sortDirection: 'asc', itemsView: 'full' } },
    ])
  })

  it('切走会话后停止读取后续历史页', async () => {
    let current = true
    const calls: Call[] = []
    const rpc = {
      request: async (method: string, params: { includeTurns?: boolean }) => {
        calls.push({ method, params })
        if (params.includeTurns) throw new CodexRpcError('超限', -32000, 'response_too_large')
        if (method === 'thread/read') return { thread: { id: 'long', turns: [] } }
        current = false
        return { data: [], nextCursor: 'next-page' }
      },
    } as unknown as CodexRpcLike

    await expect(readThread(rpc, 'long', () => current)).rejects.toThrow('已取消打开会话')
    expect(calls.map((call) => call.method)).toEqual(['thread/read', 'thread/read', 'thread/turns/list'])
  })

  it('用只读请求加载指定子代理的对话记录', async () => {
    const calls: Call[] = []
    const rpc = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return {
          thread: {
            id: 'child', agentNickname: 'Review', status: { type: 'idle' },
            turns: [{ id: 'review', status: 'completed', items: [{ type: 'agentMessage', id: 'reply', text: '检查通过' }] }],
          },
        }
      },
    } as unknown as CodexRpcLike
    await expect(readSubagentThread(rpc, 'child')).resolves.toMatchObject({
      name: 'Review', view: { items: [{ kind: 'agent', text: '检查通过' }] },
    })
    expect(calls).toEqual([{ method: 'thread/read', params: { threadId: 'child', includeTurns: true } }])
    await expect(readSubagentThread(rpc, 'another')).rejects.toThrow('会话与请求不一致')
  })

  it('listModels 按游标翻页拼接', async () => {
    const pages: Record<string, unknown> = {
      first: { data: [{ id: 'a' }], nextCursor: 'c1' },
      c1: { data: [{ id: 'b' }], nextCursor: null },
    }
    const seen: unknown[] = []
    const rpc = {
      request: async (_method: string, params: { cursor?: string }) => {
        seen.push(params)
        return pages[params.cursor ?? 'first']
      },
    } as unknown as CodexRpcLike
    const models = await listModels(rpc)
    expect(models.map((model) => model.id)).toEqual(['a', 'b'])
    expect(seen).toEqual([{}, { cursor: 'c1' }])
  })

  it('listSkills 合并多个 cwd 并按名称去重、跳过禁用', async () => {
    const seen: unknown[] = []
    const rpc = {
      request: async (_method: string, params: unknown) => {
        seen.push(params)
        return {
          data: [
            { cwd: '/a', skills: [{ name: 'x', enabled: true }, { name: 'off', enabled: false }], errors: [] },
            { cwd: '/b', skills: [{ name: 'x', enabled: true }, { name: 'y', enabled: true }], errors: [] },
          ],
        }
      },
    } as unknown as CodexRpcLike
    expect((await listSkills(rpc, '/a')).map((s) => s.name)).toEqual(['x', 'y'])
    expect(seen).toEqual([{ cwds: ['/a'] }])
  })
})

