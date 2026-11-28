import type { AgentKind, GlobalAccessMode, HiddenModels } from '@qn/codex-client'

/** 目标上可用的对话 Agent（mvp §11、T22）；缺省为 codex。 */
export type { AgentKind }

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
  /** 已经 SSH 开启的直连加速：连接时先试 TLS 直连，失败回退 SSH；授权 token 存 secrets（directToken） */
  direct?: SshDirect
  /** 仅 targets.list 返回时附带（不落盘）：是否已保存可用的密码（password 认证）或私钥口令（key 认证） */
  hasSavedSecret?: boolean
}

export type SshDirect = {
  /** 直连拨号地址（缺省为 SSH 主机），可填 frp/Tailscale 地址 */
  host: string
  port: number
  /** 证书 DER 的 SHA-256，小写十六进制 */
  fingerprint: string
  /** 远端授权 id，关闭时用于撤销 */
  grantId: string
}

export type EnableDirectParams = {
  id: string
  /** 已有监听时沿用远端配置，只签发本机授权 */
  reuseListener?: boolean
  /** 远端监听地址，host:port 或 port；缺省 47390 */
  listen?: string
  /** 写进连接配置的拨号地址；缺省为 SSH 主机 */
  host?: string
  /** 允许公网来源（默认只接受局域网/Tailscale/本机转发） */
  allowPublic?: boolean
  password?: string
  passphrase?: string
}

/** 连接测试结果：认证通过且远端环境满足部署要求。 */
export type TargetProbe = { os: string; nodeVersion: string }

/** 服务端直连：远端自行运行 `qn-server.cjs serve`，桌面端经 TLS（证书指纹固定）连接；token 存 secrets。 */
export type DirectTarget = {
  id: string
  kind: 'direct'
  name: string
  host: string
  port: number
  /** 证书 DER 的 SHA-256，小写十六进制 */
  fingerprint: string
}

export type DirectTargetInput = {
  id?: string
  kind: 'direct'
  name: string
  host: string
  port: number
  fingerprint: string
  /** 新建时必填；编辑时不传则沿用已保存的 */
  token?: string
}

export type LocalTarget = { id: 'local'; kind: 'local'; name: string }
export type Target = LocalTarget | SshTarget | DirectTarget

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
  /** 工作区信任：false 时禁止运行配置，Agent 只能用默认权限。旧数据缺省视为已信任。 */
  trusted: boolean
  /** 用户在项目管理里隐藏的项目：电脑侧栏与手机端都不显示。缺省为显示。 */
  hidden?: boolean
}

export type MobileSettings = {
  enabled: boolean
  terminalEnabled?: boolean
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
  terminalEnabled?: boolean
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
  /** 直连目标的授权 token */
  token?: string
  /** SSH 目标开启直连加速后的授权 token */
  directToken?: string
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

// T23 设置界面：字段名是写入 userData/settings.json 的白名单，未知字段一律丢弃。
export type SettingsSendKey = 'enter' | 'ctrlEnter'
export type SettingsDensity = 'comfortable' | 'compact'
/** 界面主题：深色为默认，灰色是抬亮的中性灰，浅色是白底。 */
export type SettingsTheme = 'dark' | 'gray' | 'light'
export type SettingsAgentKind = AgentKind
export const AUTO_ARCHIVE_DAYS = [0, 1, 7, 14, 30, 60, 90, 180] as const
export type AutoArchiveDays = (typeof AUTO_ARCHIVE_DAYS)[number]

export function isAutoArchiveDays(value: unknown): value is AutoArchiveDays {
  return AUTO_ARCHIVE_DAYS.some((days) => days === value)
}

export type AgentPrefs = {
  enabled: boolean
  /** 可执行文件绝对路径；留空表示由目标机自动解析 */
  path?: string
  /** 仅 Codex / Claude：CODEX_HOME / CLAUDE_CONFIG_DIR，只存路径字符串，不读其中内容 */
  configDir?: string
}
export type AppSettings = {
  general: {
    sendKey: SettingsSendKey
    autoConnectLast: boolean
    autoArchiveDays: AutoArchiveDays
    defaultAgent: SettingsAgentKind
    globalAccessMode: GlobalAccessMode
    density: SettingsDensity
    theme: SettingsTheme
    chatFontSize: number
    composerFontSize: number
    editorFontSize: number
    terminalFontSize: number
    /** 字号默认值的版本，用于把旧默认值迁移到新默认（见 shared/fontSizes.ts），界面不展示 */
    fontSizesVersion: number
    sidebarFontSize: number
    projectFontSize: number
    sessionFontSize: number
    /** 用户在模型选择器里隐藏的模型 id，按 Agent 各一份；没有隐藏项时省略。手机经网关只读。 */
    hiddenModels?: HiddenModels
  }
  /** 按目标 id 分组，每个 agent 一份偏好 */
  agents: Record<string, Partial<Record<SettingsAgentKind, AgentPrefs>>>
}
export type AppSettingsPatch = {
  general?: Partial<AppSettings['general']>
  agents?: Record<string, Partial<Record<SettingsAgentKind, Partial<AgentPrefs>>>>
}
export type AppInfo = { name: string; version: string }

export interface BackendMethods {
  'targets.list': { params: void; result: Target[] }
  'targets.save': { params: SshTargetInput | DirectTargetInput; result: SshTarget | DirectTarget }
  'targets.remove': { params: { id: string }; result: void }
  'target.connect': {
    params: { id: string; password?: string; passphrase?: string; remember?: boolean; startup?: boolean }
    result: void
  }
  'target.forceUpdate': { params: { id: string }; result: void }
  /** 用表单里的当前值试连，不保存、不部署；带 id 时未填的密码/口令取已保存的。 */
  'target.test': {
    params: SshTargetInput & { password?: string; passphrase?: string }
    result: TargetProbe
  }
  'target.forgetSecret': { params: { id: string }; result: void }
  /** 经 SSH 在远端开启直连并为本机签发授权，结果写回目标配置；之后连接优先直连 */
  'target.enableDirect': { params: EnableDirectParams; result: SshTarget }
  /** 经 SSH 撤销本机授权并清除直连配置（远端监听保留给其它客户端） */
  'target.disableDirect': {
    params: { id: string; password?: string; passphrase?: string }
    result: SshTarget
  }
  'projects.list': { params: { targetId?: string }; result: Project[] }
  'projects.save': {
    params: { id?: string; targetId: string; name?: string; path: string; trusted?: boolean; hidden?: boolean }
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
  'mobile.pairQr': { params: { address: string }; result: { rows: string[] } }
  'mobile.devices': { params: void; result: MobileDevice[] }
  'mobile.revokeDevice': { params: { id: string }; result: void }
  'mobile.regenerateCert': { params: void; result: MobileRegenerateResult }
  'settings.get': { params: void; result: AppSettings }
  'settings.save': { params: AppSettingsPatch; result: AppSettings }
  'app.info': { params: void; result: AppInfo }
}

export type BackendMethod = keyof BackendMethods
export type BackendParams<M extends BackendMethod> = BackendMethods[M]['params']
export type BackendResult<M extends BackendMethod> = BackendMethods[M]['result']

export interface BackendEvents {
  'settings.access': { globalAccessMode: AppSettings['general']['globalAccessMode'] }
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
