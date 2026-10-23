export type SshAgentPhase =
  | 'disconnected'
  | 'authenticating'
  | 'probing'
  | 'installing'
  | 'handshaking'
  | 'readyAgent'
  | 'readyDirect'

export type SshAgentMode = 'agent' | 'direct' | 'unknown'

export type SshAgentTransport = 'daemon' | 'serve' | 'direct'

export type SshAgentState = {
  connectionId: string
  rootUri: string
  phase: SshAgentPhase
  mode: SshAgentMode
  version: string | null
  transport: SshAgentTransport | null
  reason: string | null
}

const PHASES = new Set<SshAgentPhase>([
  'disconnected',
  'authenticating',
  'probing',
  'installing',
  'handshaking',
  'readyAgent',
  'readyDirect',
])

const MODES = new Set<SshAgentMode>(['agent', 'direct', 'unknown'])
const TRANSPORTS = new Set<SshAgentTransport>(['daemon', 'serve', 'direct'])

export type SshAgentChip =
  | { kind: 'version'; version: string }
  | { kind: 'agent' }
  | { kind: 'direct' }
  | { kind: 'pending' }

export type SshAgentTipLine = {
  key: string
  params?: Record<string, string>
}

export function parseSshAgentState(value: unknown): SshAgentState | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const connectionId = record.connectionId
  const rootUri = record.rootUri
  const phase = record.phase
  const mode = record.mode
  if (typeof connectionId !== 'string' || typeof rootUri !== 'string') return null
  if (typeof phase !== 'string' || !PHASES.has(phase as SshAgentPhase)) return null
  if (typeof mode !== 'string' || !MODES.has(mode as SshAgentMode)) return null
  const version = nullableString(record.version)
  const reason = nullableString(record.reason)
  const transport = nullableTransport(record.transport)
  if (version === undefined || reason === undefined || transport === undefined) return null
  return {
    connectionId,
    rootUri,
    phase: phase as SshAgentPhase,
    mode: mode as SshAgentMode,
    version,
    transport,
    reason,
  }
}

export function sshAgentChip(state: SshAgentState | null): SshAgentChip | null {
  if (!state || state.phase === 'disconnected') return null
  if (state.phase === 'readyAgent') {
    return state.version ? { kind: 'version', version: state.version } : { kind: 'agent' }
  }
  if (state.phase === 'readyDirect') return { kind: 'direct' }
  return { kind: 'pending' }
}

export function sshAgentTransportKey(transport: SshAgentTransport | null): string | null {
  if (transport === 'daemon') return '常驻 daemon'
  if (transport === 'serve') return '项目 serve'
  if (transport === 'direct') return '直连'
  return null
}

export function sshAgentPhaseKey(phase: SshAgentPhase): string {
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
    case 'readyAgent':
      return '已就绪'
    case 'readyDirect':
      return '直连'
  }
}

export function sshAgentTipLines(state: SshAgentState): SshAgentTipLine[] {
  if (state.phase === 'readyDirect' || state.mode === 'direct') {
    return state.reason
      ? [{ key: '直连：{reason}', params: { reason: state.reason } }]
      : [{ key: '直连' }]
  }
  const lines: SshAgentTipLine[] = []
  if (state.version) lines.push({ key: 'Agent v{version}', params: { version: state.version } })
  else lines.push({ key: 'Agent' })
  const transport = sshAgentTransportKey(state.transport)
  if (transport) lines.push({ key: '传输：{transport}', params: { transport } })
  lines.push({ key: '阶段：{phase}', params: { phase: sshAgentPhaseKey(state.phase) } })
  if (state.reason) lines.push({ key: '原因：{reason}', params: { reason: state.reason } })
  return lines
}

export function sshAgentEventMatches(eventRootUri: string, activeRootUri: string): boolean {
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

function nullableTransport(value: unknown): SshAgentTransport | null | undefined {
  if (value == null) return null
  return typeof value === 'string' && TRANSPORTS.has(value as SshAgentTransport)
    ? (value as SshAgentTransport)
    : undefined
}
