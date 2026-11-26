import { describe, expect, it } from 'vitest'
import {
  agentLabel,
  agentPlaceholder,
  availabilityReason,
  classifyAgentOpenError,
  emptyAgentStatus,
  isAgentKind,
  parseSessionKey,
  preferredAgent,
  sessionKey,
} from './agents'

describe('agent 会话键与标签', () => {
  it('目标 id 含冒号时仍可还原', () => {
    expect(sessionKey('ssh:host:22', 'claude')).toBe('claude:ssh:host:22')
    expect(parseSessionKey('claude:ssh:host:22')).toEqual({
      agent: 'claude',
      targetId: 'ssh:host:22',
    })
    expect(parseSessionKey('codex:local')).toEqual({ agent: 'codex', targetId: 'local' })
    expect(parseSessionKey('local')).toEqual({ agent: 'codex', targetId: 'local' })
  })

  it('agent 守卫、标签与占位符', () => {
    expect(isAgentKind('claude')).toBe(true)
    expect(isAgentKind('other')).toBe(false)
    expect(agentLabel('codex')).toBe('Codex')
    expect(agentPlaceholder('claude')).toBe('和 Claude 一起工作')
  })
})

describe('agent 可用性', () => {
  it('缺少可执行文件才置为不可用，连接问题是暂时状态', () => {
    expect(classifyAgentOpenError('claude', { code: 'agent_unavailable', message: '未找到 claude' }))
      .toEqual({ state: 'unavailable', detail: '未找到 claude' })
    expect(classifyAgentOpenError('codex', new Error('spawn codex ENOENT')).state).toBe('unavailable')
    expect(classifyAgentOpenError('codex', { code: 'not_connected', message: '目标未连接' }).state)
      .toBe('unknown')
    expect(classifyAgentOpenError('codex', new Error('超时')).state).toBe('error')
  })

  it('优先选已就绪的 agent，其次避开明确不可用的', () => {
    const status = emptyAgentStatus()
    expect(preferredAgent(status)).toBe('codex')
    status.codex = { state: 'unavailable', detail: '未找到 codex' }
    status.claude = { state: 'ready', version: '2.1.331' }
    expect(preferredAgent(status)).toBe('claude')
    expect(availabilityReason('claude', status.claude)).toContain('2.1.331')
    expect(availabilityReason('codex', status.codex)).toBe('未找到 codex')
    expect(availabilityReason('claude', undefined)).toBe('等待连接后检测')
  })
})
