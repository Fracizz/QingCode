/** 目标上可用的对话 Agent（mvp §11）；缺省为 codex。 */
export type AgentKind = 'codex' | 'claude'

// 渲染进程 ↔ backend 的线协议类型（mvp.md §5）。这里只描述形状，不含任何 IO。

export type SshAuth =
  | { kind: 'password' }
  | { kind: 'key'; keyPath: string }
  | { kind: 'agent' }

export type SshTargetInput = {
  id?: string
  name: string
  host: string
  port: number
  username: string
  auth: SshAuth
}

export type SshTarget = {
  id: string
  kind: 'ssh'
  name: string
  host: string
  port: number
  username: string
  auth: SshAuth
}

export type LocalTarget = { id: 'local'; kind: 'local'; name: string }
export type Target = LocalTarget | SshTarget

export const LOCAL_TARGET: LocalTarget = { id: 'local', kind: 'local', name: '本机' }

export type TargetState = 'idle' | 'connecting' | 'deploying' | 'ready' | 'error'
export type TargetStateEvent = { id: string; state: TargetState; detail?: string }

export type HostKeyPrompt = {
  promptId: string
  host: string
  port: number
  fingerprint: string
  kind: 'new' | 'changed'
  previous?: string
}

export type Project = {
  id: string
  targetId: string
  name: string
  path: string
  lastOpenedAt: number
}

export type MobileSettings = {
  enabled: boolean
  port: number
  hasPassword: boolean
  publicAddresses: string[]
  lanAddresses: string[]
  fingerprint: string
  running: boolean
  error?: string
}
export type MobileSettingsView = MobileSettings
export type MobileSettingsInput = {
  enabled?: boolean
  port?: number
  password?: string
  publicAddresses?: string[]
}
export type MobileDevice = {
  id: string
  name: string
  pairedAt: number
  lastSeenAt: number
  lastIp: string
}
export type MobileDeviceInfo = MobileDevice
export type MobileConnectionInfo = { text: string; link: string }
export type MobileRegenerateResult = { fingerprint: string }

// 明文只存在于内存与 safeStorage 密文之间，禁止写入日志或普通 JSON。
export type SavedSecret = {
  password?: string
  passphrase?: string
}

export type LegacyCounts = {
  connections: number
  localProjects: number
  sshProjects: number
  secrets: number
}

export type LegacyDetectResult = {
  found: boolean
  path: string
  counts: LegacyCounts
}

export type LegacySkipped = { kind: string; name: string; reason: string }

export type LegacyImportResult = {
  imported: { targets: number; projects: number; hostKeys: number; secrets: number }
  skipped: LegacySkipped[]
}

export interface BackendMethods {
  'targets.list': { params: void; result: Target[] }
  'targets.save': { params: SshTargetInput; result: SshTarget }
  'targets.remove': { params: { id: string }; result: void }
  'target.connect': {
    params: { id: string; password?: string; passphrase?: string; remember?: boolean }
    result: void
  }
  'target.forgetSecret': { params: { id: string }; result: void }
  'projects.list': { params: { targetId?: string }; result: Project[] }
  'projects.save': {
    params: { id?: string; targetId: string; name?: string; path: string }
    result: Project
  }
  'projects.remove': { params: { id: string }; result: void }
  'legacy.detect': { params: { path?: string }; result: LegacyDetectResult }
  'legacy.import': {
    params: { path?: string; includeSecrets: boolean }
    result: LegacyImportResult
  }
  'target.disconnect': { params: { id: string }; result: void }
  'hostKey.respond': { params: { promptId: string; accept: boolean }; result: void }
  'server.req': {
    params: { targetId: string; method: string; params?: unknown }
    result: unknown
  }
  'codex.send': { params: { targetId: string; agent?: AgentKind; msg: unknown }; result: void }
  'mobile.getSettings': { params: void; result: MobileSettings }
  'mobile.saveSettings': { params: MobileSettingsInput; result: MobileSettings }
  'mobile.connectionInfo': { params: { address: string }; result: MobileConnectionInfo }
  'mobile.devices': { params: void; result: MobileDevice[] }
  'mobile.revokeDevice': { params: { id: string }; result: void }
  'mobile.regenerateCert': { params: void; result: MobileRegenerateResult }
}

export type BackendMethod = keyof BackendMethods
export type BackendParams<M extends BackendMethod> = BackendMethods[M]['params']
export type BackendResult<M extends BackendMethod> = BackendMethods[M]['result']

export interface BackendEvents {
  'target.state': TargetStateEvent
  'hostKey.prompt': HostKeyPrompt
  'codex.recv': { targetId: string; agent?: AgentKind; seq: number | null; msg: unknown }
  'server.evt': { targetId: string; name: string; payload: unknown }
}

export type BackendEvent = keyof BackendEvents

export type BackendError = { code: string; message: string }

export type BackendRequest = { t: 'req'; id: number; method: string; params?: unknown }
export type BackendResponseOk = { t: 'res'; id: number; ok: true; result: unknown }
export type BackendResponseErr = { t: 'res'; id: number; ok: false; error: BackendError }
export type BackendResponse = BackendResponseOk | BackendResponseErr
export type BackendEventMessage = { t: 'evt'; name: string; payload: unknown }
export type WireMessage = BackendRequest | BackendResponse | BackendEventMessage

export type TypedRequest<M extends BackendMethod> = {
  t: 'req'
  id: number
  method: M
  params: BackendParams<M>
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const hasOwn = (x: object, k: string): boolean => Object.prototype.hasOwnProperty.call(x, k)

export function isBackendRequest(x: unknown): x is BackendRequest {
  return (
    isRecord(x) &&
    x.t === 'req' &&
    typeof x.id === 'number' &&
    Number.isFinite(x.id) &&
    typeof x.method === 'string'
  )
}

export function isBackendResponse(x: unknown): x is BackendResponse {
  if (!isRecord(x) || x.t !== 'res' || typeof x.id !== 'number' || !Number.isFinite(x.id)) {
    return false
  }
  if (x.ok === true) return hasOwn(x, 'result')
  if (x.ok === false) {
    return (
      isRecord(x.error) &&
      (typeof x.error.code === 'string' || typeof x.error.code === 'number') &&
      typeof x.error.message === 'string'
    )
  }
  return false
}

export function isBackendEventMessage(x: unknown): x is BackendEventMessage {
  return (
    isRecord(x) && x.t === 'evt' && typeof x.name === 'string' && hasOwn(x, 'payload')
  )
}
