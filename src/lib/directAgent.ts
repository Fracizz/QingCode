import { safeInvoke } from './tauri'
import type { SshConnection } from '../types'
import type { SshRuntimeConfig } from './sshWorkspace'

/** Pairing secrets stay in transient component state and the native credential store. */
export interface DirectAgentInfo {
  enabled: boolean
  host: string
  port: number
  certificateFingerprint: string
  tokenSaved: boolean
  previousPorts: number[]
}

export interface DirectAgentTarget {
  connectionId: string
  host: string
  port: number
  certificateFingerprint: string
  token?: string
}

export interface DirectAgentPairing {
  host?: string
  port: number
  certificateFingerprint: string
  token: string
}

export interface DirectAgentFirewallTarget {
  connectionId: string
  sshConnectionId: string
  agentHost: string
  port: number
  config: SshRuntimeConfig
}

export interface DirectAgentFirewallPlan {
  host: string
  sshPort: number
  username: string
  port: number
  clientAddress: string
  localAddress: string
  networkCategory: string
  interfaceAlias: string
  account: string
  profiles: string[]
  ruleName: string
  alreadyEnabled: boolean
  canApply: boolean
  reason: string | null
  planSha256: string
  hostFingerprint: string
}

export interface DirectAgentFirewallResult {
  changed: boolean
  ruleName: string
  port: number
  clientAddress: string
  profiles: string[]
}

export interface DirectAgentApi {
  info(connectionId: string): Promise<DirectAgentInfo | null>
  provision(connectionId: string, port?: number): Promise<DirectAgentInfo>
  probe(host: string, port: number): Promise<{ certificateFingerprint: string }>
  test(target: DirectAgentTarget): Promise<{ version: string; protocol: number }>
  save(target: DirectAgentTarget & { enabled: boolean }): Promise<void>
  firewallPlan?(target: DirectAgentFirewallTarget): Promise<DirectAgentFirewallPlan>
  firewallApply?(target: DirectAgentFirewallTarget & { expectedPlanSha256: string }): Promise<DirectAgentFirewallResult>
}

export const directAgentApi: DirectAgentApi = {
  info: connectionId => safeInvoke('读取 Server 直连配置', 'direct_agent_info', { connectionId }),
  provision: (connectionId, port) => safeInvoke('安装 Server 直连服务', 'direct_agent_provision', { connectionId, port }),
  probe: (host, port) => safeInvoke('检查 Server 服务器身份', 'direct_agent_probe', { host, port }),
  test: target => safeInvoke('测试 Server 直连', 'direct_agent_test', { ...target }),
  save: target => safeInvoke('保存 Server 直连配置', 'direct_agent_save', { ...target }),
  firewallPlan: target => safeInvoke('检查 SSH 防火墙授权', 'direct_agent_firewall_plan', { ...target }),
  firewallApply: target => safeInvoke('通过 SSH 放行 Server 端口', 'direct_agent_firewall_apply', { ...target }),
}

/** Agent placeholders are not SSH identities. Never select a different host implicitly. */
export function directAgentSshCandidates(connections: readonly SshConnection[], host: string): SshConnection[] {
  const normalized = host.trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (!normalized) return []
  return connections.filter(connection =>
    connection.host.trim().replace(/^\[|\]$/g, '').toLowerCase() === normalized &&
    !(connection.username === 'Agent' && connection.auth_kind === 'password' && /^[a-f\d]{64}$/i.test(connection.host_key_fingerprint))
  )
}

/** Metadata only: native credentials never enter the frontend or this compatibility check. */
export async function hasDirectAgentConnection(connectionId: string): Promise<boolean> {
  try {
    return (await directAgentApi.info(connectionId))?.enabled === true
  } catch {
    // Older desktop runtimes do not expose the direct Agent command.
    return false
  }
}

/** Enrich display labels from native metadata without copying credentials or replacing SSH settings. */
export async function enrichDirectAgentConnections(connections: readonly SshConnection[]): Promise<SshConnection[]> {
  return Promise.all(connections.map(async connection => {
    const result = { ...connection }
    delete result.agentEndpoint
    try {
      const info = await directAgentApi.info(connection.id)
      if (info?.enabled && info.host && Number.isInteger(info.port) && info.port > 0 && info.port <= 65535) {
        result.agentEndpoint = { host: info.host, port: info.port }
      }
    } catch {
      // Preserve ordinary SSH labels when running against an older native backend.
    }
    return result
  }))
}

export function validateDirectAgentTarget(host: string, port: string): string | null {
  if (!host.trim() || /[\s/@?#]/.test(host.trim())) return '请填写主机名或 IP 地址，不要包含协议或路径。'
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return 'Server 端口必须是 1–65535 之间的整数。'
  }
  return null
}

export function parseDirectAgentPairing(text: string): DirectAgentPairing {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object') throw new Error('配对信息格式无效，请粘贴服务端输出的配对 JSON。')
  const candidate = value as Record<string, unknown>
  const fingerprint = candidate.certificateFingerprint ?? candidate.certificateSha256
  const host = candidate.host ?? candidate.hostname
  if (
    typeof candidate.port !== 'number' || !Number.isInteger(candidate.port) ||
    candidate.port < 1 || candidate.port > 65535 ||
    typeof fingerprint !== 'string' || !fingerprint.trim() ||
    typeof candidate.token !== 'string' || !candidate.token.trim() ||
    (host !== undefined && typeof host !== 'string')
  ) throw new Error('配对信息格式无效，请粘贴服务端输出的配对 JSON。')
  return {
    host: host as string | undefined,
    port: candidate.port,
    certificateFingerprint: fingerprint.trim(),
    token: candidate.token,
  }
}

/** Only a validated integer can enter the copyable administration command. */
export function directAgentFirewallCommand(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return `New-NetFirewallRule -DisplayName 'QingCode Agent TCP ${port}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Private,Domain`
}

export function directAgentErrorKey(error: unknown): string {
  const text = String(error)
  if (text.includes('[direct:ssh-auth]')) return 'SSH 授权失败。请检查 SSH 密码、私钥或口令后重试。'
  if (text.includes('[direct:ssh-identity]')) return 'SSH 主机身份未确认或已变化。请先在远程连接中测试并确认 SSH 指纹。'
  if (text.includes('[direct:firewall-admin]')) return '当前 SSH 账户没有修改防火墙的权限。请使用远端管理员账户授权。'
  if (text.includes('[direct:firewall-unsupported]')) return '此主机不支持通过 SSH 自动放行。请按下方说明手动配置防火墙。'
  if (text.includes('[direct:firewall-stale]')) return '防火墙配置或连接目标已变化。请重新检查并确认放行范围。'
  if (text.includes('[direct:firewall]')) return 'SSH 防火墙操作失败。请检查远端权限、现有规则和连接状态后重试。'
  if (text.includes('[direct:record]')) return '直连已验证，但本机连接记录保存失败。请保持此窗口打开并重试保存。'
  if (text.includes('[direct:identity]')) return 'Server 证书指纹不匹配。请核对远端身份后重新确认。'
  if (text.includes('[direct:auth]')) return 'Server 认证失败。请重新导入该服务的配对信息。'
  if (text.includes('[direct:timeout]')) return '连接超时。请检查主机地址、TCP 端口、防火墙及网络映射。'
  if (text.includes('[direct:unreachable]')) return '无法连接 Server。请确认服务正在监听，并开放显示的 TCP 端口。'
  if (text.includes('[direct:protocol]')) return 'Server 协议版本不兼容。请更新客户端或远端服务。'
  return 'Server 操作失败。请检查服务状态后重试。'
}
