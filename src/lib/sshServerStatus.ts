export type SshServerPhase =
  | 'disconnected'
  | 'authenticating'
  | 'probing'
  | 'installing'
  | 'handshaking'
  | 'readyServer'
  | 'readyDirect'

/** 与后端 `ServerMode`（serde camelCase）一致：`server` / `direct` / `unknown`。 */
export type SshServerMode = 'server' | 'direct' | 'unknown'

export type SshServerTransport = 'daemon' | 'serve' | 'direct'

export type SshServerState = {
  connectionId: string
  rootUri: string
  phase: SshServerPhase
  mode: SshServerMode
  version: string | null
  transport: SshServerTransport | null
  reason: string | null
}

const PHASES = new Set<SshServerPhase>([
  'disconnected',
  'authenticating',
  'probing',
  'installing',
  'handshaking',
  'readyServer',
  'readyDirect',
])

const MODES = new Set<SshServerMode>(['server', 'direct', 'unknown'])

/**
 * 旧名兼容：代理改名 qingcode-server 之前载荷里是 `agent`。后端现在发 `server`，
 * 之前前端只认 `agent`，导致所有 readyServer 载荷被整条丢弃、芯片永远停在中间阶段。
 */
function normalizeMode(mode: unknown): SshServerMode | null {
  if (mode === 'agent') return 'server'
  return typeof mode === 'string' && MODES.has(mode as SshServerMode) ? (mode as SshServerMode) : null
}
const TRANSPORTS = new Set<SshServerTransport>(['daemon', 'serve', 'direct'])

export type SshServerChip =
  | { kind: 'agent' }
  | { kind: 'direct' }
  | { kind: 'pending' }

export type SshServerTipLine = {
  key: string
  params?: Record<string, string>
}

export function parseSshServerState(value: unknown): SshServerState | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const connectionId = record.connectionId
  const rootUri = record.rootUri
  const phase = record.phase
  const mode = normalizeMode(record.mode)
  if (typeof connectionId !== 'string' || typeof rootUri !== 'string') return null
  if (typeof phase !== 'string' || !PHASES.has(phase as SshServerPhase)) return null
  if (!mode) return null
  const version = nullableString(record.version)
  const reason = nullableString(record.reason)
  const transport = nullableTransport(record.transport)
  if (version === undefined || reason === undefined || transport === undefined) return null
  return {
    connectionId,
    rootUri,
    phase: phase as SshServerPhase,
    mode,
    version,
    transport,
    reason,
  }
}

export function sshServerChip(state: SshServerState | null): SshServerChip | null {
  if (!state || state.phase === 'disconnected') return null
  if (state.phase === 'readyServer') return { kind: 'agent' }
  if (state.phase === 'readyDirect') return { kind: 'direct' }
  return { kind: 'pending' }
}

export function sshServerTransportKey(transport: SshServerTransport | null): string | null {
  if (transport === 'daemon') return '常驻 daemon'
  if (transport === 'serve') return '项目 serve'
  if (transport === 'direct') return '直连'
  return null
}

export function sshServerPhaseKey(phase: SshServerPhase): string {
  switch (phase) {
    case 'disconnected':
      return '未连接'
    case 'authenticating':
      return '正在认证'
    case 'probing':
      return '正在探测'
    case 'installing':
      return '正在安装'
    case 'handshaking':
      return '正在握手'
    case 'readyServer':
      return '已就绪'
    case 'readyDirect':
      return '直连'
  }
}

/** tooltip 只保留原因首行：完整多行原因（如部署诊断细节）留给详情弹窗。 */
function shortReason(reason: string): string {
  return reason.split('\n', 1)[0].trim()
}

/** 单行摘要：状态栏只给一句话，完整信息留给「查看 Server 详情」弹窗。 */
export function sshServerTipLines(state: SshServerState): SshServerTipLine[] {
  if (state.phase === 'readyDirect' || state.mode === 'direct') {
    return state.reason
      ? [{ key: '直连：{reason}', params: { reason: shortReason(state.reason) } }]
      : [{ key: '直连' }]
  }
  if (state.phase === 'readyServer') {
    return state.version
      ? [{ key: 'Server v{version}', params: { version: state.version } }]
      : [{ key: 'Server' }]
  }
  const lines: SshServerTipLine[] = [
    { key: '阶段：{phase}', params: { phase: sshServerPhaseKey(state.phase) } },
  ]
  if (state.reason) lines.push({ key: '原因：{reason}', params: { reason: shortReason(state.reason) } })
  return lines
}

/** 与后端 server_status.rs 的直连原因保持一致。 */
const REASON_SERVER_DISABLED = '已关闭 ssh.server.enabled'
const REASON_UNTRUSTED = '工作区未信任'

/**
 * 直连状态下能否一键切到 Server：返回 null 表示可以直接重新部署；
 * 总开关关闭或工作区未信任时重新部署也只会回到直连，返回需要先处理的提示 key。
 */
export function sshServerSwitchBlocker(state: SshServerState): string | null {
  const reason = state.reason?.trim() ?? ''
  if (reason.startsWith(REASON_SERVER_DISABLED)) {
    return '远端服务已在设置中关闭，请先在 设置 › 功能 中开启「SSH › 服务: 远端服务」'
  }
  if (reason.startsWith(REASON_UNTRUSTED)) return '请先信任该工作区，再切换到 Server'
  return null
}

/** 当前是否处于直连（含部署失败后的回退），用于决定是否展示「切换到 Server」。 */
export function sshServerIsDirect(state: SshServerState): boolean {
  return state.phase === 'readyDirect' || state.mode === 'direct'
}

export function sshServerEventMatches(eventRootUri: string, activeRootUri: string): boolean {
  return eventRootUri === activeRootUri
}

export function isAgentCommandUnavailable(error: unknown): boolean {
  if (error instanceof Error && error.name === 'NotInTauriError') return true
  const message = error instanceof Error ? error.message : String(error)
  return /not found|unknown command|找不到命令/i.test(message)
}

function nullableString(value: unknown): string | null | undefined {
  if (value == null) return null
  return typeof value === 'string' ? value : undefined
}

function nullableTransport(value: unknown): SshServerTransport | null | undefined {
  if (value == null) return null
  return typeof value === 'string' && TRANSPORTS.has(value as SshServerTransport)
    ? (value as SshServerTransport)
    : undefined
}
