import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentKind } from '../../../../shared/backendApi'
import { sessionKey } from '../../lib/agents'
import { pendingSendKey, useCodex } from '../../store/codex'
import { defaultAppSettings } from '../settings/settingsModel'
import { useSettings } from '../settings/settingsStore'
import { emptyAccessMemory, getAccessMode } from './accessModel'

type Call = {
  method: string
  targetId: string
  agent?: AgentKind
  params?: Record<string, unknown>
  msg?: { id: string; method: string; params: Record<string, unknown> }
}

const backend = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Set<(payload: unknown) => void>(),
}))

vi.mock('../../lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/backend')>(),
  call: backend.call,
  on: (name: string, listener: (payload: unknown) => void) => {
    if (name === 'codex.recv') backend.listeners.add(listener)
    return () => backend.listeners.delete(listener)
  },
}))

const targetId = 'target'
const threadId = 'thread'
const agent = 'codex'
const address = { targetId, agent, threadId } as const
const opened = { initialize: {}, lastSeq: 0, capabilities: { accessModes: true, agentConfigDir: true } }
const session = () => useCodex.getState().sessions[sessionKey(targetId, agent)]

function receive(msg: unknown, target = targetId, kind: AgentKind = agent) {
  for (const listener of backend.listeners) listener({ targetId: target, agent: kind, seq: null, msg })
}

function configure(directory: string) {
  const settings = defaultAppSettings()
  settings.agents = { [targetId]: { codex: { enabled: true, configDir: directory } } }
  useSettings.setState({ settings })
}

async function answer(method: string, params: Call) {
  if (method === 'server.req') return params.method === 'codex.open' ? opened : { lastSeq: 0 }
  const msg = params.msg
  if (method !== 'codex.send' || !msg) return {}
  const result = msg.method === 'thread/start'
    ? { thread: { id: threadId, status: { type: 'idle' }, turns: [] } }
    : msg.method === 'turn/start'
      ? { turn: { id: msg.id, status: 'inProgress', items: [] } }
      : { data: [] }
  receive({ id: msg.id, result }, params.targetId, params.agent)
  return {}
}

const sentTurns = () => backend.call.mock.calls
  .map(([, params]) => (params as Call).msg)
  .filter((msg) => msg?.method === 'turn/start')

beforeEach(() => {
  for (const live of Object.values(useCodex.getState().sessions)) {
    live.rpc.dispose()
    live.transport.dispose()
  }
  backend.listeners.clear()
  backend.call.mockReset().mockImplementation(answer)
  useSettings.setState({ settings: defaultAppSettings() })
  useCodex.setState({
    sessions: {}, agents: {}, currentTargetId: targetId, currentAgent: agent, currentCwd: '/work',
    currentThreadId: null, sending: false, pendingSends: {}, access: emptyAccessMemory,
  })
})

describe('桌面会话访问模式和配置目录', () => {
  it('草稿的首条消息继承总控，排队消息使用发送时的设置', async () => {
    const settings = defaultAppSettings()
    settings.general.globalAccessMode = 'auto'
    useSettings.setState({ settings })
    const { send } = useCodex.getState()
    expect(await send('开始对话')).toBe(true)
    expect(sentTurns()[0]?.params).toMatchObject({ approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' } })

    expect(await send('排队消息')).toBe(true)
    useSettings.setState({ settings: defaultAppSettings() })
    const first = sentTurns()[0]!
    receive({ method: 'turn/completed', params: { threadId, turn: { id: first.id, status: 'completed', items: [] } } })
    await vi.waitFor(() => expect(sentTurns()).toHaveLength(2))
    expect(sentTurns()[1]?.params).not.toHaveProperty('sandboxPolicy')
  })

  it('首条消息带入草稿权限，恢复队列时使用会话当前选择', async () => {
    const { ensureOpen, setAccessMode, send, retryPendingSend } = useCodex.getState()
    expect(await ensureOpen(targetId, agent)).toBe(true)
    setAccessMode({ ...address, threadId: null }, 0, 'fullAccess')
    expect(await send('开始对话')).toBe(true)
    expect(sentTurns()[0]?.params).toMatchObject({
      approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, qingcodeAccessOverride: true,
    })
    expect(getAccessMode(useCodex.getState().access, address)).toBe('fullAccess')

    expect(await send('排队消息')).toBe(true)
    const first = sentTurns()[0]!
    receive({ method: 'turn/completed', params: { threadId, turn: { id: first.id, status: 'failed', items: [] } } })
    expect(useCodex.getState().pendingSends[pendingSendKey(address)]?.[0]?.error).toBeTruthy()
    setAccessMode(address, 0, 'default')
    retryPendingSend(address)
    await vi.waitFor(() => expect(sentTurns()).toHaveLength(2))
    expect(sentTurns()[1]?.params).not.toHaveProperty('sandboxPolicy')
    expect(sentTurns()[1]?.params).not.toHaveProperty('qingcodeAccessOverride')
  })

  it('切换设置后向已打开的目标重新发送配置目录，运行中保留原连接', async () => {
    configure('/old')
    const { ensureOpen } = useCodex.getState()
    expect(await ensureOpen(targetId, agent)).toBe(true)
    expect(session()?.openedConfig?.directory).toBe('/old')
    expect(backend.call).toHaveBeenCalledWith('server.req', {
      targetId, method: 'codex.open', params: { agent, codexHome: '/old' },
    })
    const queueKey = pendingSendKey(address)
    const otherAgentKey = pendingSendKey({ ...address, agent: 'claude' })
    const queued = [{ id: 1, text: '旧配置目录', input: [], overrides: {} }]
    useCodex.setState({ pendingSends: { [queueKey]: queued, [otherAgentKey]: queued } })

    configure('/new')
    backend.call.mockImplementationOnce(async () => {
      throw Object.assign(new Error('请等待本轮结束'), { code: 'config_dir_busy' })
    })
    expect(await ensureOpen(targetId, agent)).toBe(false)
    expect(session()).toMatchObject({ opened: true, openedConfig: { directory: '/old' } })
    expect(useCodex.getState().pendingSends[queueKey]).toEqual(queued)
    expect(await ensureOpen(targetId, agent)).toBe(true)
    expect(session()?.openedConfig?.directory).toBe('/new')
    expect(useCodex.getState().pendingSends).toEqual({ [otherAgentKey]: queued })

    configure('')
    expect(await ensureOpen(targetId, agent)).toBe(true)
    expect(session()?.openedConfig?.directory).toBeUndefined()
    expect(backend.call).toHaveBeenCalledWith('server.req', { targetId, method: 'codex.open', params: { agent } })
  })
})
