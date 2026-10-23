import { describe, expect, it } from 'vitest'
import {
  isAgentCommandUnavailable,
  parseSshAgentState,
  sshAgentChip,
  sshAgentEventMatches,
  sshAgentTipLines,
  type SshAgentState,
} from './sshAgentStatus'

const readyAgent: SshAgentState = {
  connectionId: 'c1',
  rootUri: 'ssh://c1/home/app',
  phase: 'readyAgent',
  mode: 'agent',
  version: '0.1.13',
  transport: 'daemon',
  reason: null,
}

describe('sshAgentStatus', () => {
  it('parses a camelCase payload and rejects a bad phase', () => {
    expect(parseSshAgentState(readyAgent)).toEqual(readyAgent)
    expect(parseSshAgentState({ ...readyAgent, phase: 'booting' })).toBeNull()
    expect(parseSshAgentState({ ...readyAgent, version: 1 })).toBeNull()
  })

  it('hides a disconnected chip and labels the ready states', () => {
    expect(sshAgentChip(null)).toBeNull()
    expect(sshAgentChip({ ...readyAgent, phase: 'disconnected' })).toBeNull()
    expect(sshAgentChip(readyAgent)).toEqual({ kind: 'version', version: '0.1.13' })
    expect(sshAgentChip({ ...readyAgent, version: null })).toEqual({ kind: 'agent' })
    expect(sshAgentChip({ ...readyAgent, phase: 'readyDirect', mode: 'direct', transport: 'direct', version: null, reason: '已关闭 ssh.agent.enabled' })).toEqual({ kind: 'direct' })
    expect(sshAgentChip({ ...readyAgent, phase: 'installing' })).toEqual({ kind: 'pending' })
  })

  it('builds the direct and agent tips', () => {
    expect(sshAgentTipLines({
      ...readyAgent,
      phase: 'readyDirect',
      mode: 'direct',
      transport: 'direct',
      version: null,
      reason: '工作区未信任',
    })).toEqual([{ key: '直连：{reason}', params: { reason: '工作区未信任' } }])
    expect(sshAgentTipLines(readyAgent).map(line => line.key)).toEqual([
      'Agent v{version}',
      '传输：{transport}',
      '阶段：{phase}',
    ])
  })

  it('ignores events for a different project', () => {
    expect(sshAgentEventMatches('ssh://c1/home/app', 'ssh://c1/home/app')).toBe(true)
    expect(sshAgentEventMatches('ssh://c2/other', 'ssh://c1/home/app')).toBe(false)
  })

  it('treats a missing command as unavailable', () => {
    expect(isAgentCommandUnavailable(Object.assign(new Error('command ssh_agent_info not found'), { name: 'Error' }))).toBe(true)
    expect(isAgentCommandUnavailable(Object.assign(new Error('browser'), { name: 'NotInTauriError' }))).toBe(true)
    expect(isAgentCommandUnavailable(new Error('连接已断开'))).toBe(false)
  })
})
