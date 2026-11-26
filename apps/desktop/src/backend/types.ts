import type { AgentKind } from '../shared/backendApi'
import type { DirectTarget, SshTarget, TargetState } from '../shared/backendApi'

// 后端与具体传输（本机命名管道 / SSH exec 通道）之间只依赖这组形状，便于单测替换。

export type TargetCredentials = {
  password?: string
  passphrase?: string
  /** 直连目标的授权 token */
  token?: string
  /** SSH 目标开启直连加速后的授权 token */
  directToken?: string
}

export interface TargetLink {
  /** 连接可用但需要提醒用户的情况（如旧版 server 未能替换），就绪时随状态展示。 */
  notice?: string
  request(method: string, params?: unknown): Promise<unknown>
  codexSend(msg: unknown, agent?: AgentKind): void
  close(): void
}

export interface LinkHooks {
  onState(state: TargetState, detail?: string): void
  onEvent(name: string, payload: unknown): void
  onCodexRecv(seq: number | null, msg: unknown, agent: AgentKind): void
  onClose(err?: Error): void
}

export interface HostKeyVerifier {
  verify(host: string, port: number, fingerprint: string, interactive?: boolean): Promise<boolean>
}

/** 建立 SSH 连接所需的最小信息；连接测试只需要这些。 */
export interface SshTestContext {
  target: SshTarget
  credentials: TargetCredentials
  gate: HostKeyVerifier
}

/** 经 SSH 执行远端 server 子命令（开启/关闭直连等）所需的信息。 */
export interface SshRemoteContext extends SshTestContext {
  resourcesPath: string
  onState?(detail: string): void
}

export interface SshLinkContext extends SshTestContext {
  hooks: LinkHooks
  userData: string
  resourcesPath: string
  appVersion: string
  signal?: AbortSignal
}

export interface DirectLinkContext {
  target: DirectTarget
  token: string
  hooks: LinkHooks
  appVersion: string
  /** 缺省 10s；SSH 目标试直连时用更短的值以便尽快回退 */
  connectTimeoutMs?: number
  signal?: AbortSignal
}

export interface LocalLinkContext {
  hooks: LinkHooks
  electronPath: string
  serverScript: string
  appVersion: string
}

export type LinkFactory<C> = (context: C) => Promise<TargetLink>

export type BackendEmit = (name: string, payload: unknown) => void
