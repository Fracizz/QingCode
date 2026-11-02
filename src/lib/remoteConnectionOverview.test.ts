import { describe, expect, it } from 'vitest'
import { connectionStatus, groupConnectionProjects, matchesConnection } from './remoteConnectionOverview'
import type { Project, SshConnection } from '../types'
import type { SshServerState } from './sshServerStatus'

const connection: SshConnection = { id: 'c1', name: 'WSL', host: 'dev.test', port: 22, username: 'dev', auth_kind: 'privateKey', host_key_fingerprint: 'sha', created_at: 1 }
const project = (name: string, time: number): Project => ({ id: name, name, path: `ssh://c1/home/code/${name}`, created_at: 1, last_opened_at: time })
const state = (phase: SshServerState['phase'], reason: string | null = null): SshServerState => ({ connectionId: 'c1', rootUri: 'ssh://c1/home/code/app', connectionMode: 'server', phase, mode: 'server', transport: 'daemon', version: '1', reason })

describe('remote connection overview', () => {
  it('includes hidden SSH projects, orders by real usage, and keeps native WSL separate', () => {
    const projects = [project('old', 1), { ...project('recent', 3), hidden: 1 }, project('middle', 2), { ...project('native', 4), path: 'wsl://Ubuntu/home/app', kind: 'wsl' as const }]
    expect(groupConnectionProjects(projects).get('c1')?.map(p => p.name)).toEqual(['recent', 'middle', 'old'])
    expect(projects[0].name).toBe('old')
  })

  it('searches account, address, port and hidden project paths with multiple case-insensitive terms', () => {
    const projects = [{ ...project('nem-panel', 1), hidden: 1 }]
    for (const query of ['WSL', 'DEV.TEST 22', 'DEV NEM-PANEL', '/HOME/CODE']) expect(matchesConnection(connection, projects, query)).toBe(true)
    expect(matchesConnection(connection, projects, 'missing')).toBe(false)
    expect(matchesConnection({ ...connection, agentEndpoint: { host: 'tls.test', port: 48763 } }, [], 'TLS.TEST 48763')).toBe(true)
  })

  it('distinguishes unavailable status checks from disconnected connections', () => {
    expect(connectionStatus(null, [], 'IPC failed')).toMatchObject({ label: '检查失败', attention: true })
    expect(connectionStatus(false, [])).toMatchObject({ label: '未连接', attention: false })
    expect(connectionStatus(undefined, []).label).toBe('正在检查…')
  })

  it('surfaces a failing project even while another project on the connection is ready', () => {
    expect(connectionStatus(true, [state('readyServer'), state('handshaking', 'authentication failed')])).toMatchObject({ attention: true, tone: 'warn' })
    expect(connectionStatus(true, [state('readyServer'), state('disconnected', 'connection lost')]).attention).toBe(true)
    expect(connectionStatus(true, [state('installing')]).label).toBe('正在准备服务')
    expect(connectionStatus(true, [state('readyServer')]).label).toBe('服务已就绪')
    expect(connectionStatus(true, [state('readyDirect')]).label).toBe('已连接')
  })
})
