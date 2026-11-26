import { describe, expect, it } from 'vitest'
import {
  interruptTurn,
  listModels,
  listSkills,
  listThreads,
  readThread,
  resumeThread,
  sendText,
  startThread,
} from './api'
import type { CodexRpcLike } from './api'

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

