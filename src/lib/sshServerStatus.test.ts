import { describe, expect, it } from 'vitest'
import {
  isAgentCommandUnavailable,
  parseSshServerState,
  parseSshServerTimings,
  sshServerChip,
  sshServerEventMatches,
  sshServerIsDirect,
  sshServerSwitchBlocker,
  sshServerTipLines,
  type SshServerState,
} from './sshServerStatus'

const readyServer: SshServerState = {
  connectionId: 'c1',
  rootUri: 'ssh://c1/home/app',
  phase: 'readyServer',
  mode: 'server',
  version: '0.1.13',
  transport: 'daemon',
  reason: null,
  timings: null,
}

describe('sshServerStatus', () => {
  it('offers switching to Server from direct mode unless a precondition blocks it', () => {
    const direct: SshServerState = { ...readyServer, phase: 'readyDirect', mode: 'direct', transport: 'direct', version: null, reason: 'server 启动超时' }
    expect(sshServerIsDirect(readyServer)).toBe(false)
    expect(sshServerIsDirect(direct)).toBe(true)
    expect(sshServerSwitchBlocker(direct)).toBeNull()
    expect(sshServerSwitchBlocker({ ...direct, reason: null })).toBeNull()
    expect(sshServerSwitchBlocker({ ...direct, reason: '已关闭 ssh.server.enabled' })).toContain('设置')
    expect(sshServerSwitchBlocker({ ...direct, reason: '工作区未信任' })).toContain('信任')
  })

  it('accepts the backend server mode and maps the legacy agent alias', () => {
    // 后端 ServerMode::Server 序列化为 "server"；曾因前端只认 agent 而整条丢弃。
    expect(parseSshServerState({ ...readyServer, mode: 'server' })?.mode).toBe('server')
    expect(parseSshServerState({ ...readyServer, mode: 'agent' })?.mode).toBe('server')
    expect(parseSshServerState({ ...readyServer, mode: 'proxy' })).toBeNull()
  })

  it('parses optional timings and shows an offline chip only for unexpected disconnects', () => {
    expect(parseSshServerState(readyServer)?.timings).toBeNull()
    expect(parseSshServerState({ ...readyServer, timings: '发现 1.2s · 合计 1.5s' })?.timings).toBe(
      '发现 1.2s · 合计 1.5s',
    )
    expect(parseSshServerState({ ...readyServer, timings: 3 })).toBeNull()
    const disconnected: SshServerState = {
      ...readyServer,
      phase: 'disconnected',
      mode: 'unknown',
      version: null,
      transport: null,
    }
    expect(sshServerChip(disconnected)).toBeNull()
    expect(sshServerChip({ ...disconnected, reason: '保活超时' })).toEqual({ kind: 'offline' })
  })

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

describe('parseSshServerTimings', () => {
  it('splits stages, total and background stages', () => {
    expect(
      parseSshServerTimings('状态目录 0.0s · 启动 serve 2.7s · 合计 17.5s · daemon 7.4s（后台）'),
    ).toEqual({
      stages: [
        { label: '状态目录', seconds: 0, background: false },
        { label: '启动 serve', seconds: 2.7, background: false },
        { label: 'daemon', seconds: 7.4, background: true },
      ],
      total: 17.5,
    })
    expect(parseSshServerTimings('daemon 0.9s（后台）')).toEqual({
      stages: [{ label: 'daemon', seconds: 0.9, background: true }],
      total: null,
    })
  })

  it('rejects summaries it does not understand', () => {
    expect(parseSshServerTimings('')).toBeNull()
    expect(parseSshServerTimings('发现 1.2s · 奇怪的段')).toBeNull()
  })
})
