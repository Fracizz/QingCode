import type { SshConnectionMode } from '../types'

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

export type SshServerTransport = 'daemon' | 'serve' | 'direct' | 'agent'

export type SshServerState = {
  connectionId: string
  rootUri: string
  phase: SshServerPhase
  mode: SshServerMode
  /** 连接配置里的模式（连接时固定）；旧版后端不发，按 server 兼容。 */
  connectionMode: SshConnectionMode
  version: string | null
  transport: SshServerTransport | null
  reason: string | null
  /** 最近一次发现/部署的分阶段耗时摘要；旧版后端不发此字段。 */
  timings?: string | null
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
const TRANSPORTS = new Set<SshServerTransport>(['daemon', 'serve', 'direct', 'agent'])

export type SshServerChip =
  | { kind: 'agent' }
  | { kind: 'direct' }
  /** 高级兼容模式：SSH 直连，不部署远端服务。 */
  | { kind: 'ssh' }
  | { kind: 'pending' }
  /** 意外断线（保活超时、远端断开）：后台正在自动重连。 */
  | { kind: 'offline' }

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
  // 旧版后端不发 connectionMode：按 server 兼容，避免整条状态被丢弃。
  const connectionMode: SshConnectionMode =
    record.connectionMode === 'ssh' ? 'ssh' : 'server'
  // timings 缺省（旧版后端）按 null 处理，类型不符才判为非法载荷。
  const timings = record.timings === undefined ? null : nullableString(record.timings)
  if (version === undefined || reason === undefined || transport === undefined) return null
  if (timings === undefined) return null
  return {
    connectionId,
    rootUri,
    phase: phase as SshServerPhase,
    mode,
    connectionMode,
    version,
    transport,
    reason,
    timings,
  }
}

export function sshServerChip(state: SshServerState | null): SshServerChip | null {
  if (!state) return null
  // 主动断开没有原因，芯片隐藏；意外断线带原因，显示「已断开」直到自动重连成功。
  if (state.phase === 'disconnected') return state.reason ? { kind: 'offline' } : null
  if (state.phase === 'readyServer') return { kind: 'agent' }
  if (state.phase === 'readyDirect') return { kind: state.connectionMode === 'ssh' ? 'ssh' : 'direct' }
  return { kind: 'pending' }
}

/**
 * 面向用户的连接模式。区分 SSH 上的增强服务与独立 HTTPS/WSS Agent。
 */
export function sshServerModeKey(state: SshServerState): string {
  if (state.transport === 'agent') {
    if (state.phase === 'disconnected') return state.reason ? 'Agent 已断开' : '未连接'
    if (state.phase === 'authenticating') return 'Agent 正在认证'
    if (state.phase === 'handshaking') return '正在连接 Agent 服务'
    return 'Agent 端口直连'
  }
  // 兼容连接不部署远端服务，明确标明这是用户主动启用的兼容模式。
  if (state.connectionMode === 'ssh' && state.phase === 'readyDirect') {
    return 'SSH 直连（兼容模式）'
  }
  if (state.phase === 'readyServer') return 'SSH + 远端服务'
  if (state.phase === 'readyDirect') return 'SSH 直连'
  switch (state.phase) {
    case 'disconnected':
      return state.reason ? 'SSH 已断开' : '未连接'
    case 'authenticating':
      return 'SSH 正在认证'
    case 'probing':
      return '正在检查远端服务'
    case 'installing':
      return '正在安装远端服务'
    case 'handshaking':
      return '正在连接远端服务'
  }
}

export function sshServerTransportKey(transport: SshServerTransport | null): string | null {
  if (transport === 'agent') return 'HTTPS / WSS'
  if (transport === 'daemon') return '常驻服务'
  if (transport === 'serve') return '按项目服务'
  if (transport === 'direct') return '纯 SSH'
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

/** 状态栏提示先说明连接模式，再给出运行方式或回退原因。 */
export function sshServerTipLines(state: SshServerState): SshServerTipLine[] {
  if (state.connectionMode === 'ssh' && state.phase === 'readyDirect') {
    return [{ key: 'SSH 直连（兼容模式）' }, { key: '已启用兼容模式，不部署远端服务' }]
  }
  if (state.phase === 'readyDirect') {
    const lines: SshServerTipLine[] = [{ key: 'SSH 直连' }]
    if (state.reason) {
      lines.push({ key: '回退原因：{reason}', params: { reason: shortReason(state.reason) } })
    }
    return lines
  }
  if (state.phase === 'readyServer') {
    const lines: SshServerTipLine[] = [{ key: sshServerModeKey(state) }]
    const transport = sshServerTransportKey(state.transport)
    if (transport) lines.push({ key: '运行方式：{transport}', params: { transport } })
    if (state.version) {
      lines.push({ key: '远端服务 v{version}', params: { version: state.version } })
    }
    return lines
  }
  const lines: SshServerTipLine[] = [{ key: sshServerModeKey(state) }]
  lines.push({ key: '阶段：{phase}', params: { phase: sshServerPhaseKey(state.phase) } })
  if (state.reason) lines.push({ key: '原因：{reason}', params: { reason: shortReason(state.reason) } })
  return lines
}

/** 与后端 server_status.rs 的直连原因保持一致。 */
const REASON_UNTRUSTED = '工作区未信任'

/**
 * 直连状态下能否一键切到远端服务：返回 null 表示可以直接重新部署；
 * 工作区未信任时重新部署也只会回到直连，返回需要先处理的提示 key。
 * SSH 模式是连接配置，可以随时切换，因此没有阻塞项。
 */
export function sshServerSwitchBlocker(state: SshServerState): string | null {
  if (state.connectionMode === 'ssh') return null
  const reason = state.reason?.trim() ?? ''
  if (reason.startsWith(REASON_UNTRUSTED)) return '请先信任该工作区，再切换到远端服务'
  return null
}

/** 连接配置为 SSH 模式（零足迹直连）：没有远端服务，芯片与菜单按 SSH 模式展示。 */
export function sshServerDisabledBySetting(state: SshServerState): boolean {
  return state.connectionMode === 'ssh'
}

/** 当前是否处于直连（含部署失败后的回退），用于决定是否展示「切换到远端服务」。 */
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

export interface SshServerTimingStage {
  label: string
  seconds: number
  /** 后台阶段（如 daemon 探测）不计入「合计」，展示时单独标注。 */
  background: boolean
}

export interface SshServerTimings {
  stages: SshServerTimingStage[]
  /** 到 serve 就绪的等待时长；摘要里缺少「合计」时为 null。 */
  total: number | null
}

const TIMING_SEGMENT = /^(.+?)\s+(\d+(?:\.\d+)?)s(（后台）)?$/

/**
 * 解析后端耗时摘要「状态目录 0.3s · 启动 serve 2.7s · 合计 3.0s · daemon 1.8s（后台）」。
 * 任一段格式不符就返回 null，调用方原样显示文本。
 */
export function parseSshServerTimings(summary: string): SshServerTimings | null {
  const stages: SshServerTimingStage[] = []
  let total: number | null = null
  for (const segment of summary.split(' · ')) {
    const match = TIMING_SEGMENT.exec(segment.trim())
    if (!match) return null
    const [, label, seconds, background] = match
    if (label === '合计' && !background) {
      total = Number(seconds)
    } else {
      stages.push({ label, seconds: Number(seconds), background: Boolean(background) })
    }
  }
  return stages.length > 0 || total !== null ? { stages, total } : null
}
