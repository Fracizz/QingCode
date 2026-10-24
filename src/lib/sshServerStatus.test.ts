import { describe, expect, it } from 'vitest'
import {
  isAgentCommandUnavailable,
  parseSshServerState,
  sshServerChip,
  sshServerEventMatches,
  sshServerTipLines,
  type SshServerState,
} from './sshServerStatus'

const readyServer: SshServerState = {
  connectionId: 'c1',
  rootUri: 'ssh://c1/home/app',
  phase: 'readyServer',
  mode: 'agent',
  version: '0.1.13',
  transport: 'daemon',
  reason: null,
}

describe('sshServerStatus', () => {
  it('parses a camelCase payload and rejects a bad phase', () => {
    expect(parseSshServerState(readyServer)).toEqual(readyServer)
    expect(parseSshServerState({ ...readyServer, phase: 'booting' })).toBeNull()
    expect(parseSshServerState({ ...readyServer, version: 1 })).toBeNull()
  })

  it('hides a disconnected chip and labels the ready states', () => {
    expect(sshServerChip(null)).toBeNull()
    expect(sshServerChip({ ...readyServer, phase: 'disconnected' })).toBeNull()
    expect(sshServerChip(readyServer)).toEqual({ kind: 'agent' })
    expect(sshServerChip({ ...readyServer, version: null })).toEqual({ kind: 'agent' })
    expect(sshServerChip({ ...readyServer, phase: 'readyDirect', mode: 'direct', transport: 'direct', version: null, reason: '已关闭 ssh.server.enabled' })).toEqual({ kind: 'direct' })
    expect(sshServerChip({ ...readyServer, phase: 'installing' })).toEqual({ kind: 'pending' })
  })

  it('builds concise one-line tips', () => {
    expect(sshServerTipLines({
      ...readyServer,
      phase: 'readyDirect',
      mode: 'direct',
      transport: 'direct',
      version: null,
      reason: '工作区未信任',
    })).toEqual([{ key: '直连：{reason}', params: { reason: '工作区未信任' } }])
    // 多行原因（如部署诊断输出）在 tooltip 里只保留首行，完整内容进详情弹窗。
    expect(sshServerTipLines({
      ...readyServer,
      phase: 'readyDirect',
      mode: 'direct',
      transport: 'direct',
      version: null,
      reason: '远端服务程序校验未通过：文件可能损坏。\n用法: qingcode-agent (--version | serve)\n',
    })).toEqual([{
      key: '直连：{reason}',
      params: { reason: '远端服务程序校验未通过：文件可能损坏。' },
    }])
    expect(sshServerTipLines(readyServer)).toEqual([
      { key: 'Server v{version}', params: { version: '0.1.13' } },
    ])
    expect(sshServerTipLines({ ...readyServer, version: null })).toEqual([{ key: 'Server' }])
    expect(sshServerTipLines({ ...readyServer, phase: 'installing' })).toEqual([
      { key: '阶段：{phase}', params: { phase: '正在安装' } },
    ])
  })

  it('ignores events for a different project', () => {
    expect(sshServerEventMatches('ssh://c1/home/app', 'ssh://c1/home/app')).toBe(true)
    expect(sshServerEventMatches('ssh://c2/other', 'ssh://c1/home/app')).toBe(false)
  })

  it('treats a missing command as unavailable', () => {
    expect(isAgentCommandUnavailable(Object.assign(new Error('command ssh_server_info not found'), { name: 'Error' }))).toBe(true)
    expect(isAgentCommandUnavailable(Object.assign(new Error('browser'), { name: 'NotInTauriError' }))).toBe(true)
    expect(isAgentCommandUnavailable(new Error('连接已断开'))).toBe(false)
  })
})
