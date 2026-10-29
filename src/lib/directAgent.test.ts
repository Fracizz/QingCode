import { afterEach, describe, expect, it, vi } from 'vitest'
import { directAgentApi, directAgentErrorKey, directAgentFirewallCommand, directAgentSshCandidates, enrichDirectAgentConnections, parseDirectAgentPairing, validateDirectAgentTarget } from './directAgent'
import type { SshConnection } from '../types'

afterEach(() => vi.restoreAllMocks())

describe('direct Agent target validation', () => {
  it.each(['48763tail', '48763.5', '0', '-1', '65536', '', '4e4'])('rejects invalid port %s', port => {
    expect(validateDirectAgentTarget('192.168.252.107', port)).not.toBeNull()
  })

  it.each(['https://host', 'host/path', 'user@host', 'host with spaces', ''])('rejects non-host input %s', host => {
    expect(validateDirectAgentTarget(host, '48763')).not.toBeNull()
  })

  it('accepts a hostname, IPv4 and IPv6 without requiring a website URL', () => {
    for (const host of ['dev.example.test', '192.168.252.107', '::1']) {
      expect(validateDirectAgentTarget(host, '48763')).toBeNull()
    }
  })
})

describe('direct Agent pairing import', () => {
  it('extracts only pairing fields and rejects missing credentials', () => {
    const pairing = { port: 48763, certificateFingerprint: 'SHA256:test', token: 'private-pairing-secret', host: 'server.test', extra: 'discard' }
    expect(parseDirectAgentPairing(JSON.stringify(pairing))).toEqual({ port: 48763, certificateFingerprint: 'SHA256:test', token: 'private-pairing-secret', host: 'server.test' })
    expect(() => parseDirectAgentPairing(JSON.stringify({ ...pairing, token: '' }))).toThrow()
    expect(() => parseDirectAgentPairing(JSON.stringify({ ...pairing, port: '48763' }))).toThrow()
    expect(() => parseDirectAgentPairing('null')).toThrow()
  })

  it('accepts the standalone gateway descriptor without requiring frontend field names', () => {
    expect(parseDirectAgentPairing(JSON.stringify({ hostname: '0.0.0.0', port: 48763, certificateSha256: 'a'.repeat(64), token: 'private-pairing-secret', serverVersion: 'test' })))
      .toEqual({ host: '0.0.0.0', port: 48763, certificateFingerprint: 'a'.repeat(64), token: 'private-pairing-secret' })
  })
})

describe('direct Agent network instructions', () => {
  it('only builds firewall commands for valid ports, without executing them', () => {
    expect(directAgentFirewallCommand(48763)).toContain('-Protocol TCP -LocalPort 48763')
    expect(directAgentFirewallCommand(48763)).toContain('-Profile Private,Domain')
    for (const value of [0, 65536, NaN, 123.5]) expect(directAgentFirewallCommand(value)).toBeNull()
  })

  it('distinguishes unreachable ports, authorization and changed identities without echoing errors or secrets', () => {
    const identity = directAgentErrorKey('[direct:identity] private-token')
    expect(identity).toContain('指纹不匹配')
    expect(identity).not.toContain('private-token')
    expect(directAgentErrorKey('[direct:auth]')).toContain('认证失败')
    expect(directAgentErrorKey('[direct:unreachable]')).toContain('TCP 端口')
    expect(directAgentErrorKey('[direct:timeout]')).toContain('连接超时')
    expect(directAgentErrorKey('[direct:protocol]')).toContain('版本不兼容')
    expect(directAgentErrorKey('[direct:ssh-auth] secret')).toContain('SSH 授权失败')
    expect(directAgentErrorKey('[direct:ssh-identity]')).toContain('SSH 主机身份')
    expect(directAgentErrorKey('[direct:firewall-admin]')).toContain('没有修改防火墙的权限')
    expect(directAgentErrorKey('[direct:firewall-stale]')).toContain('重新检查')
    expect(directAgentErrorKey('[direct:firewall-unsupported]')).toContain('手动配置')
  })

  it('offers matching SSH identities and excludes standalone Agent placeholders', () => {
    const ssh: SshConnection = { id: 'ssh', name: 'WinDev', host: 'HOST.test', port: 22, username: 'admin', auth_kind: 'password', host_key_fingerprint: 'SHA256:ssh', created_at: 1, updated_at: 1 }
    const placeholder = { ...ssh, id: 'placeholder', username: 'Agent', host_key_fingerprint: 'a'.repeat(64) }
    expect(directAgentSshCandidates([ssh, placeholder, { ...ssh, host: 'other.test' }], ' host.TEST ')).toEqual([ssh])
    expect(directAgentSshCandidates([{ ...ssh, host: '::1' }], '[::1]')).toHaveLength(1)
  })
})

describe('Agent endpoint display metadata', () => {
  const row: SshConnection = { id: 'agent', name: 'WinDev', host: 'old-ssh.test', port: 22, username: 'Agent', auth_kind: 'password', host_key_fingerprint: 'tls', created_at: 1, updated_at: 1 }

  it('enriches only endpoint metadata while retaining SSH configuration and excluding native credentials', async () => {
    vi.spyOn(directAgentApi, 'info').mockResolvedValue({ enabled: true, host: '192.168.252.107', port: 48763, certificateFingerprint: 'tls', tokenSaved: true, previousPorts: [50000], token: 'never-copy-native-secret' } as never)
    const [enriched] = await enrichDirectAgentConnections([row])
    expect(enriched).toEqual({ ...row, agentEndpoint: { host: '192.168.252.107', port: 48763 } })
    expect(JSON.stringify(enriched)).not.toContain('never-copy-native-secret')
    expect(row).not.toHaveProperty('agentEndpoint')
  })

  it('removes stale display endpoints after disabling Agent or when the old native backend lacks support', async () => {
    const info = vi.spyOn(directAgentApi, 'info').mockResolvedValue(null)
    const stale = { ...row, agentEndpoint: { host: 'stale.test', port: 50000 } }
    expect(await enrichDirectAgentConnections([stale])).toEqual([row])
    info.mockRejectedValue(new Error('unknown command'))
    expect(await enrichDirectAgentConnections([stale])).toEqual([row])
  })
})
