import type { ServerMessage } from '@qn/protocol'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeBridge } from './bridge'
import { buildElicitationRequest, elicitationResult } from './elicitation'

type Reply = { id?: string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

async function harness() {
  const replies: Reply[] = []
  const notes: Reply[] = []
  const deps = {
    query: () => { throw new Error('不应启动会话') },
    listSessions: async () => [],
    getSessionInfo: async (sessionId: string) => ({ sessionId, cwd: '/work', summary: '旧' }),
    getSessionMessages: async () => [],
    deleteSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
  }
  const bridge = new ClaudeBridge({
    send: (_clientId, message: ServerMessage) => { if (message.t === 'codex.recv') replies.push(message.msg as Reply) },
    broadcastRecv: (_seq, message) => { notes.push(message as Reply) },
    broadcastEvt: () => undefined,
    log: () => undefined,
  }, '0', { deps, resolve: () => ({ path: '/fake/claude', version: '0' }) })
  await bridge.open({})
  const call = async (id: string, method: string, params: Record<string, unknown>) => {
    bridge.handleClientMessage(1, { id, method, params })
    await expect.poll(() => replies.some((reply) => reply.id === id)).toBe(true)
    return replies.find((reply) => reply.id === id)!
  }
  return { bridge, deps, notes, call }
}

describe('Claude 会话删除与重命名', () => {
  it('经 SDK 公开接口处理并广播通知', async () => {
    const { bridge, deps, notes, call } = await harness()
    expect(await call('1', 'thread/name/set', { threadId: 's1', name: ' 新名 ' })).toMatchObject({ result: {} })
    expect(deps.renameSession).toHaveBeenCalledWith('s1', '新名', { dir: '/work' })
    expect(await call('2', 'thread/delete', { threadId: 's1' })).toMatchObject({ result: {} })
    expect(deps.deleteSession).toHaveBeenCalledWith('s1', { dir: '/work' })
    expect(notes.map((note) => note.method)).toEqual(['thread/name/updated', 'thread/deleted'])
    bridge.shutdown()
  })
})

describe('Claude MCP elicitation', () => {
  it('转成与 Codex 相同的请求形状', () => {
    expect(buildElicitationRequest('r', 't', null, { serverName: 's', message: 'm', mode: 'url', url: 'https://a' }))
      .toMatchObject({ method: 'mcpServer/elicitation/request', params: { mode: 'url', url: 'https://a', turnId: null } })
    expect(buildElicitationRequest('r', 't', 'turn', { serverName: 's', message: 'm' }).params)
      .toMatchObject({ mode: 'form', requestedSchema: { properties: {} } })
  })

  it('只有明确的 accept / decline 生效，其余按取消', () => {
    expect(elicitationResult({ result: { action: 'accept', content: { a: 1 } } })).toEqual({ action: 'accept', content: { a: 1 } })
    expect(elicitationResult({ result: { action: 'decline', content: null } })).toEqual({ action: 'decline' })
    expect(elicitationResult({ error: { code: -1 } })).toEqual({ action: 'cancel' })
    expect(elicitationResult({ result: {} })).toEqual({ action: 'cancel' })
  })
})
