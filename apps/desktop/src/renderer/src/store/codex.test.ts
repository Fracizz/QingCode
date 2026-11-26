import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAFT_THREAD_ID } from '@qn/codex-client'
import { sessionKey } from '../lib/agents'
import { useCodex } from './codex'

const { callMock, listeners } = vi.hoisted(() => ({
  callMock: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
}))

vi.mock('../lib/backend', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    call: callMock,
    on: (name: string, cb: (payload: unknown) => void) => {
      const bucket = listeners.get(name) ?? new Set<(payload: unknown) => void>()
      bucket.add(cb)
      listeners.set(name, bucket)
      return () => bucket.delete(cb)
    },
  }
})

type CallParams = { method?: string; agent?: string; msg?: { id?: number; method?: string } }

const emitRecv = (msg: unknown, agent = 'codex'): void => {
  for (const cb of [...(listeners.get('codex.recv') ?? [])]) {
    cb({ targetId: 'local', agent, seq: null, msg })
  }
}

/** 假 backend：codex.send 用事件回 JSON-RPC 响应，其余方法直接给结果。 */
async function fakeCall(method: string, params?: CallParams): Promise<unknown> {
  if (method === 'server.req') {
    if (params?.method === 'codex.open') return { initialize: {}, lastSeq: 0 }
    if (params?.method === 'codex.attach') return { lastSeq: 0, truncated: false }
    return {}
  }
  if (method === 'codex.send') {
    const msg = params?.msg
    const agent = params?.agent ?? 'codex'
    queueMicrotask(() => {
      const result =
        msg?.method === 'thread/start'
          ? { thread: { id: 't1', status: { type: 'idle' }, turns: [] } }
          : msg?.method === 'turn/start'
            ? { turn: { id: 'turn1', status: 'inProgress', items: [] } }
            : { data: [] }
      emitRecv({ id: msg?.id, result }, agent)
    })
    return {}
  }
  return {}
}

const viewItems = (threadId: string) =>
  useCodex.getState().sessions[sessionKey('local', 'codex')]?.state.threads[threadId]?.items ?? []

beforeEach(() => {
  listeners.clear()
  callMock.mockReset()
  callMock.mockImplementation(fakeCall)
  useCodex.setState({
    sessions: {},
    agents: {},
    currentTargetId: 'local',
    currentCwd: null,
    currentThreadId: null,
    currentAgent: 'codex',
    threads: [],
    sending: false,
    error: null,
    notice: null,
  })
})

describe('发送时的乐观用户消息', () => {
  it('不等待 codex.open 回包就先显示气泡', async () => {
    const gate: { resolve?: (value: unknown) => void } = {}
    const open = new Promise<unknown>((resolve) => {
      gate.resolve = resolve
    })
    callMock.mockImplementation((method: string, params?: CallParams) =>
      method === 'server.req' && params?.method === 'codex.open' ? open : fakeCall(method, params),
    )

    const sending = useCodex.getState().send('你好')
    // 此刻 codex.open 还挂在网络上，气泡必须已经在草稿线程里。
    expect(viewItems(DRAFT_THREAD_ID)).toMatchObject([{ kind: 'user', text: '你好', pending: true }])
    expect(useCodex.getState().sending).toBe(true)

    gate.resolve?.({ initialize: {}, lastSeq: 0 })
    await expect(sending).resolves.toBe(true)
    expect(viewItems('t1')).toMatchObject([{ kind: 'user', text: '你好' }])
  })

  it('服务端回显到达后替换占位，不会留下重复气泡', async () => {
    await expect(useCodex.getState().send('你好')).resolves.toBe(true)
    expect(viewItems('t1')).toHaveLength(1)
    emitRecv({
      method: 'item/completed',
      params: {
        threadId: 't1',
        item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: '你好' }] },
      },
    })
    expect(viewItems('t1').map((item) => item.id)).toEqual(['u1'])
  })

  it('发送失败时撤回占位、复位 sending 并返回 false', async () => {
    callMock.mockImplementation(async (method: string, params?: CallParams) => {
      if (method === 'codex.send' && params?.msg?.method === 'turn/start') throw new Error('turn 失败')
      return fakeCall(method, params)
    })
    await expect(useCodex.getState().send('你好')).resolves.toBe(false)
    expect(useCodex.getState().sending).toBe(false)
    expect(viewItems('t1').filter((item) => item.kind === 'user')).toEqual([])
  })
})
