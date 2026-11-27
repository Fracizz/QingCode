// 与电脑 backend 的线协议形状保持一致（复制自 apps/desktop/src/shared/backendApi.ts，不跨包 import）。

export type AgentKind = 'codex' | 'claude' | 'pi'

export type SshAuth =
  | { kind: 'password' }
  | { kind: 'key'; keyPath: string }
  | { kind: 'agent' }

export type SshTarget = {
  id: string
  kind: 'ssh'
  name: string
  host: string
  port: number
  username: string
  auth: SshAuth
  /** 仅 targets.list 附带：电脑上是否已保存可用的密码/口令（只有布尔值，明文不出电脑） */
  hasSavedSecret?: boolean
}

export type LocalTarget = { id: 'local'; kind: 'local'; name: string }
export type Target = LocalTarget | SshTarget

export type TargetState = 'idle' | 'connecting' | 'deploying' | 'ready' | 'error'
export type TargetStateEvent = { id: string; state: TargetState; detail?: string }

export type Project = {
  id: string
  targetId: string
  name: string
  path: string
  lastOpenedAt: number
}

export type CodexRecvEvent = {
  targetId: string
  seq: number | null
  msg: unknown
  agent?: AgentKind
}

export type ServerEvtEvent = { targetId: string; name: string; payload: unknown }

/** 手机网关 /events 的 NDJSON 每行是一条事件。 */
export type GatewayEvent = { name: string; payload?: unknown }

/** §9.2 的手机网关白名单。 */
export type RpcMethod =
  | 'targets.list'
  | 'target.connect'
  | 'projects.list'
  | 'projects.save'
  | 'server.req'
  | 'codex.send'
  | 'mobile.turn.start'
  | 'target.disconnect'
  /** 网关自有：返回各目标的 Agent 启用状态（不含路径）。 */
  | 'mobile.agents'
  | 'mobile.files.list'
  | 'mobile.files.search'
  | 'mobile.files.read'
  | 'mobile.term.open'
  | 'mobile.term.list'
  | 'mobile.term.attach'
  | 'mobile.term.detach'
  | 'mobile.term.write'
  | 'mobile.term.resize'
  | 'mobile.term.close'

export type ServerReqMethod =
  | 'ping'
  | 'fs.home'
  | 'fs.list'
  | 'codex.open'
  | 'codex.attach'
  | 'codex.status'
  // 只读文件 / Git，用于手机端查看文件与差异；写方法一律不在白名单内。
  | 'fs.read'
  | 'git.status'
  | 'git.diff'

export type FsEntry = { name: string; kind: 'dir' | 'file' | 'symlink' }
export type FsListResult = { path: string; entries: FsEntry[] }

export type Connection = {
  id: string
  name: string
  host: string
  port: number
  fp: string
  token: string
  desktopName: string
  createdAt: number
}

export type ConnectionStatus = 'unknown' | 'checking' | 'online' | 'offline' | 'mismatch'

export type ProbeResult = {
  fingerprint: string
  name: string
  version: string
  desktopName?: string
  protocol?: number
}

export type PairResult = { token: string; desktopName: string }

export type ConnectionDraft = {
  name: string
  host: string
  port: number
  fp: string
  code: string
}

export type Credentials = { password?: string; passphrase?: string; remember?: boolean }
