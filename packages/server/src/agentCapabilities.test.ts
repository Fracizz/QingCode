/**
 * 能力声明与桥实现的一致性：声明支持的能力，对应方法不得返回 -32601；声明不支持的必须返回 -32601。
 * Codex 的方法由官方 app-server 处理，daemon 只转发，不在这里核对。
 */
import { AGENT_CAPABILITIES, type AgentCapabilities, type ServerMessage } from '@qn/protocol'
import { describe, expect, it } from 'vitest'
import { ClaudeBridge } from './claude/bridge'
import type { AgentHost, AgentHostHub } from './codexHost'
import { createPiHost } from './pi/host'

const METHODS: Partial<Record<keyof AgentCapabilities, string>> = {
  rateLimits: 'account/rateLimits/read',
  rename: 'thread/name/set',
  delete: 'thread/delete',
  fork: 'thread/fork',
  archive: 'thread/archive',
  revert: 'thread/revert',
  compact: 'thread/compact/start',
  steer: 'turn/steer',
  skills: 'skills/list',
}

async function errorCodes(create: (hub: AgentHostHub) => AgentHost): Promise<Map<string, unknown>> {
  const replies = new Map<string, unknown>()
  const host = create({
    send: (_clientId, message: ServerMessage) => {
      if (message.t !== 'codex.recv') return
      const reply = message.msg as { id?: string; error?: { code?: unknown } }
      if (reply.id) replies.set(reply.id, reply.error?.code ?? null)
    },
    broadcastRecv: () => undefined,
    broadcastEvt: () => undefined,
    log: () => undefined,
  })
  await host.open({})
  // 不带参数：已实现的方法在参数校验处返回，不会启动 Agent 进程。
  for (const method of Object.values(METHODS)) host.handleClientMessage(1, { id: method, method, params: {} })
  await expect.poll(() => replies.size).toBe(Object.keys(METHODS).length)
  host.shutdown()
  return replies
}

const hosts = {
  claude: (hub: AgentHostHub) => new ClaudeBridge(hub, '0', {
    resolve: () => ({ path: '/fake/claude', version: '0' }),
    deps: {
      query: () => { throw new Error('不应启动会话') },
      listSessions: async () => [],
      getSessionMessages: async () => [],
    },
  }),
  pi: (hub: AgentHostHub) => createPiHost(hub, '0', {
    resolve: () => ({ command: 'pi', args: [], shell: false, path: 'pi', version: '0' }),
    listSessions: async () => [],
    createRpc: () => { throw new Error('不应启动进程') },
  }),
} as const

describe.each(['claude', 'pi'] as const)('%s 能力声明', (agent) => {
  it('与桥实际处理的方法一致', async () => {
    const codes = await errorCodes(hosts[agent])
    const implemented = Object.fromEntries(Object.entries(METHODS).map(([capability, method]) =>
      [capability, codes.get(method) !== -32601]))
    const declared = Object.fromEntries(Object.keys(METHODS).map((capability) =>
      [capability, AGENT_CAPABILITIES[agent][capability as keyof AgentCapabilities]]))
    expect(implemented).toEqual(declared)
  })
})
