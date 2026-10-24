export type SshServerPhase =
  | 'disconnected'
  | 'authenticating'
  | 'probing'
  | 'installing'
  | 'handshaking'
  | 'readyServer'
  | 'readyDirect'

export type SshServerMode = 'agent' | 'direct' | 'unknown'

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

const MODES = new Set<SshServerMode>(['agent', 'direct', 'unknown'])
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
  const mode = record.mode
  if (typeof connectionId !== 'string' || typeof rootUri !== 'string') return null
  if (typeof phase !== 'string' || !PHASES.has(phase as SshServerPhase)) return null
  if (typeof mode !== 'string' || !MODES.has(mode as SshServerMode)) return null
  const version = nullableString(record.version)
  const reason = nullableString(record.reason)
  const transport = nullableTransport(record.transport)
  if (version === undefined || reason === undefined || transport === undefined) return null
  return {
    connectionId,
    rootUri,
    phase: phase as SshServerPhase,
    mode: mode as SshServerMode,
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
