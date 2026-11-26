import type { AgentKind } from '../shared/backendApi'
import type { SshTarget, TargetState } from '../shared/backendApi'

// 后端与具体传输（本机命名管道 / SSH exec 通道）之间只依赖这组形状，便于单测替换。

export type TargetCredentials = {
  password?: string
  passphrase?: string
}

export interface TargetLink {
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
  verify(host: string, port: number, fingerprint: string): Promise<boolean>
}

export interface SshLinkContext {
  target: SshTarget
  credentials: TargetCredentials
  hooks: LinkHooks
  userData: string
  resourcesPath: string
  appVersion: string
  gate: HostKeyVerifier
}

export interface LocalLinkContext {
  hooks: LinkHooks
  electronPath: string
  serverScript: string
  appVersion: string
}

export type LinkFactory<C> = (context: C) => Promise<TargetLink>

export type BackendEmit = (name: string, payload: unknown) => void
