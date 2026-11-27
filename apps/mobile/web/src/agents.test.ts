import { describe, expect, it } from 'vitest'
import {
  agentLabel,
  agentPlaceholder,
  enabledAgents,
  exitedAgent,
  mergeThreadSummaries,
  parseMobileAgents,
  pickDefaultAgent,
  recvAgent,
  recvSessionKey,
  sessionKey,
  threadKey,
} from './agents'
import { toThreadSummaries } from './state'

describe('会话键与事件路由', () => {
  it('会话按 targetId + agent 区分，目标 id 可含冒号', () => {
    expect(sessionKey('local', 'codex')).toBe('codex:local')
    expect(sessionKey('ssh:93', 'claude')).toBe('claude:ssh:93')
    expect(threadKey('pi', 't1')).toBe('pi:t1')
    expect(agentLabel('claude')).toBe('Claude')
    expect(agentPlaceholder('pi')).toBe('和 pi 一起工作')
  })

  it('codex.recv 按 payload.agent 路由，缺省视为 codex', () => {
    expect(recvAgent({ targetId: 'local', agent: 'claude' })).toBe('claude')
    expect(recvAgent({ targetId: 'local' })).toBe('codex')
    expect(recvAgent({ targetId: 'local', agent: 'gpt' })).toBe('codex')
    expect(recvSessionKey({ targetId: 'local', agent: 'pi', msg: {} })).toBe('pi:local')
    expect(recvSessionKey({ targetId: 'ssh-93', msg: {} })).toBe('codex:ssh-93')
    expect(recvSessionKey({ msg: {} })).toBeNull()
    expect(recvSessionKey(null)).toBeNull()
  })

  it('codex.exited 带 agent 时只影响该 agent', () => {
    expect(exitedAgent({ targetId: 'local', name: 'codex.exited', payload: { agent: 'claude', code: 1 } })).toBe('claude')
    expect(exitedAgent({ targetId: 'local', name: 'codex.exited', payload: { code: 1 } })).toBeNull()
  })
})

describe('启用状态与默认 Agent', () => {
  const settings = parseMobileAgents({
    defaultAgent: 'claude',
    agents: {
      local: { codex: { enabled: true }, claude: { enabled: true }, pi: { enabled: false }, path: 'x' },
      'ssh-93': { claude: { enabled: false } },
      bad: 'x',
    },
  })

  it('解析网关裁剪结果，丢弃未知字段', () => {
    expect(settings).toEqual({
      defaultAgent: 'claude',
      agents: {
        local: { codex: { enabled: true }, claude: { enabled: true }, pi: { enabled: false } },
        'ssh-93': { claude: { enabled: false } },
      },
    })
    expect(parseMobileAgents(null)).toBeNull()
    expect(parseMobileAgents({ defaultAgent: 'gpt' })).toEqual({ defaultAgent: 'codex', agents: {} })
  })

  it('取不到设置时只显示 Codex；未配置的 Agent 默认启用', () => {
    expect(enabledAgents(null, 'local')).toEqual(['codex'])
    expect(enabledAgents(settings, 'local')).toEqual(['codex', 'claude'])
    expect(enabledAgents(settings, 'ssh-93')).toEqual(['codex', 'pi'])
    expect(enabledAgents(settings, 'other')).toEqual(['codex', 'claude', 'pi'])
  })

  it('默认取 defaultAgent，不可用时退回第一个可用的', () => {
    expect(pickDefaultAgent('claude', ['codex', 'claude'])).toBe('claude')
    expect(pickDefaultAgent('claude', ['codex', 'pi'])).toBe('codex')
    expect(pickDefaultAgent('claude', ['codex', 'claude'], new Set(['claude']))).toBe('codex')
    expect(pickDefaultAgent('codex', ['codex', 'claude'], new Set(['codex']))).toBe('claude')
    // 全部不可用时仍给出一个候选，让用户看到具体错误。
    expect(pickDefaultAgent('codex', ['codex'], new Set(['codex']))).toBe('codex')
    expect(pickDefaultAgent(null, [])).toBe('codex')
  })
})

describe('会话列表合并', () => {
  it('各 Agent 的会话按创建时间降序合并并保留 Agent 标注', () => {
    const codex = toThreadSummaries({ data: [{ id: 'a', preview: 'A', updatedAt: 100 }, { id: 'c', preview: 'C', updatedAt: 300 }] }, 'codex')
    const claude = toThreadSummaries({ data: [{ id: 'b', preview: 'B', updatedAt: 200 }, { id: 'a', preview: 'A2', updatedAt: 100 }] }, 'claude')
    const merged = mergeThreadSummaries([codex, claude, []])
    expect(merged.map((item) => `${item.agent}:${item.id}`)).toEqual(['codex:c', 'claude:b', 'claude:a', 'codex:a'])
    expect(toThreadSummaries({ data: [{ id: 'x' }] })[0]?.agent).toBe('codex')
  })
})
