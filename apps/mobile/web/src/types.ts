// 与电脑 backend 的线协议形状保持一致（复制自 apps/desktop/src/shared/backendApi.ts，不跨包 import）。

export type AgentKind = 'codex' | 'claude'

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
  | 'target.disconnect'

export type ServerReqMethod =
  | 'ping'
  | 'fs.home'
  | 'fs.list'
  | 'codex.open'
  | 'codex.attach'
  | 'codex.status'

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
