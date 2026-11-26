import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '@qn/protocol'
import type { AgentHostHub } from '../codexHost'
import { createPiHost } from './host'
import type { PiRpcProcess, PiRpcOptions, RpcRecord } from './rpc'
import type { PiSessionInfo } from './sessions'

interface FakeRpc extends PiRpcProcess {
  emit(record: RpcRecord): void
}

function fakeRpc(state: { commands: string[]; closed: boolean }): FakeRpc {
  const listeners = new Set<(record: RpcRecord) => void>()
  const rpc = {
    running: true,
    pid: 4321,
    start: () => undefined,
    close: () => {
      state.closed = true
      ;(rpc as { running: boolean }).running = false
    },
    command: async (type: string, _payload: RpcRecord = {}): Promise<RpcRecord> => {
      state.commands.push(type)
      switch (type) {
        case 'new_session':
          return { type: 'response', success: true, data: { cancelled: false } }
        case 'get_state':
          return {
            type: 'response',
            success: true,
            data: { sessionId: 'fake-session', sessionFile: '/tmp/fake-session.jsonl' },
          }
        case 'switch_session':
          return { type: 'response', success: true, data: { cancelled: false } }
        case 'get_messages':
          return { type: 'response', success: true, data: { messages: [] } }
        case 'prompt':
          return { type: 'response', success: true, data: { disposition: 'started' } }
        default:
          return { type: 'response', success: true, data: {} }
      }
    },
    onEvent: (cb: (record: RpcRecord) => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    onExit: () => () => undefined,
    emit: (record: RpcRecord) => {
      for (const cb of [...listeners]) cb(record)
    },
  }
  return rpc as unknown as FakeRpc
}

function harness(sessions: PiSessionInfo[] = []) {
  const sent: { clientId: number; msg: ServerMessage }[] = []
  const broadcasts: { seq: number; msg: RpcRecord }[] = []
  const evts: { name: string; payload: Record<string, unknown> }[] = []
  const logs: string[] = []
  const hub: AgentHostHub = {
    send: (clientId, msg) => sent.push({ clientId, msg }),
    broadcastRecv: (seq, msg) => broadcasts.push({ seq, msg: msg as RpcRecord }),
    broadcastEvt: (name, payload) => evts.push({ name, payload }),
    log: (message) => logs.push(message),
  }
  const state = { commands: [] as string[], closed: false }
  let rpc = fakeRpc(state)
  const rpcOptions: PiRpcOptions[] = []
  const host = createPiHost(hub, '0.0.1', {
    resolve: () => ({ command: 'pi', args: [], shell: false, path: 'pi', version: '1.6.1' }),
    listSessions: async () => sessions,
    createRpc: (options) => {
      rpcOptions.push(options)
      rpc = fakeRpc(state)
      return rpc
    },
  })
  return { host, sent, broadcasts, evts, logs, state, rpcOptions, rpc: () => rpc }
}

function responseFor(sent: { msg: ServerMessage }[], id: number): RpcRecord | undefined {
  const frame = sent.find(
    (entry) =>
      entry.msg.t === 'codex.recv' &&
      (entry.msg.msg as { id?: unknown })?.id === id,
  )
  return frame && frame.msg.t === 'codex.recv' ? (frame.msg.msg as RpcRecord) : undefined
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('PiHost（v2 JSON-RPC 外观）', () => {
  it('codex.open 返回 initialize:null、agentVersion 与 capabilities', async () => {
    const { host, state } = harness()
    const opened = await host.open({})
    expect(opened.initialize).toBeNull()
    expect(opened.agentVersion).toBe('1.6.1')
    expect(opened.lastSeq).toBe(0)
    expect((opened as { capabilities?: unknown }).capabilities).toEqual({
      approvals: false,
      rateLimits: false,
    })
    // 打开阶段只做 --version 探测，不开会话、不发 prompt。
    expect(state.commands).toEqual([])
    expect(host.status()).toMatchObject({ running: true, activeTurns: 0 })
  })

  it('thread/start → turn/start → 事件 → turn/completed，且广播带 seq', async () => {
    const { host, sent, broadcasts, rpc } = harness()
    await host.open({})
    host.handleClientMessage(1, { id: 1, method: 'thread/start', params: { cwd: '/work' } })
    await flush()
    const started = responseFor(sent, 1)
    const threadId = ((started?.result as { thread?: { id?: string } })?.thread?.id) ?? ''
    expect(threadId).toBe('fake-session')
    expect((started?.result as { approvalPolicy?: string })?.approvalPolicy).toBe('never')

    host.handleClientMessage(1, {
      id: 2,
      method: 'turn/start',
      params: { threadId, input: [{ type: 'text', text: '你好', text_elements: [] }] },
    })
    await flush()
    expect(broadcasts.some((entry) => entry.msg.method === 'turn/started')).toBe(true)
    expect(host.activeTurns).toBe(1)

    rpc().emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    rpc().emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    })
    rpc().emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '你好' },
    })
    rpc().emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '你好' },
    })
    rpc().emit({ type: 'agent_settled', aborted: false })

    expect(broadcasts.some((entry) => entry.msg.method === 'item/agentMessage/delta')).toBe(true)
    const completed = broadcasts.find((entry) => entry.msg.method === 'turn/completed')
    expect((completed?.msg.params as { turn?: { status?: string } })?.turn?.status).toBe('completed')
    expect(host.activeTurns).toBe(0)
    expect(broadcasts.every((entry) => typeof entry.seq === 'number' && entry.seq > 0)).toBe(true)
  })

  it('不支持的 v2 方法返回 -32601，且不生成审批请求', async () => {
    const { host, sent, broadcasts } = harness()
    await host.open({})
    host.handleClientMessage(1, { id: 9, method: 'account/rateLimits/read', params: {} })
    await flush()
    expect((responseFor(sent, 9)?.error as { code?: number })?.code).toBe(-32601)
    expect(broadcasts.some((entry) => String(entry.msg.method).includes('requestApproval'))).toBe(false)
  })

  it('thread/list 与 thread/read 走只读会话解析 / switch_session + get_messages', async () => {
    const { host, sent, state } = harness([
      {
        meta: { id: 'fake-session', cwd: '/work', preview: '列出当前目录' },
        sessionFile: '/tmp/fake-session.jsonl',
      },
    ])
    await host.open({})
    host.handleClientMessage(1, { id: 3, method: 'thread/list', params: { cwd: '/work' } })
    await flush()
    const listed = (responseFor(sent, 3)?.result as { data?: { id: string }[] })?.data
    expect(listed).toHaveLength(1)
    expect(listed?.[0]?.id).toBe('fake-session')

    host.handleClientMessage(1, { id: 4, method: 'thread/read', params: { threadId: 'fake-session' } })
    await flush()
    expect((responseFor(sent, 4)?.result as { thread?: { id?: string } })?.thread?.id).toBe(
      'fake-session',
    )
    expect(state.commands).toContain('switch_session')
    expect(state.commands).toContain('get_messages')
  })

  it('shutdown 结束全部 pi 子进程', async () => {
    const { host, state } = harness()
    await host.open({})
    host.handleClientMessage(1, { id: 1, method: 'thread/start', params: { cwd: '/work' } })
    await flush()
    host.shutdown()
    expect(state.closed).toBe(true)
    expect(host.status().running).toBe(false)
  })
})
