import { describe, expect, it } from 'vitest'
import {
  interruptTurn,
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
    await interruptTurn(rpc, 'thread-1', 'turn-1')

    expect(calls).toEqual([
      { method: 'thread/list', params: { cwd: '/repo' } },
      { method: 'thread/list', params: {} },
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
      { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } },
    ])
  })
})
