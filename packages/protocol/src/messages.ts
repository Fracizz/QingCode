import type { AgentCapabilities } from './agents'
import type { WorkspaceMethods } from './workspace'
import { PROTOCOL_VERSION } from './constants'
import { hasOwn, isErrorMessage, isNumber, isRecord, isString } from './guards'

export type ClientInfo = { name: string; version: string }
export type WireError = { code: string | number; message: string }

/** §11.2：缺省 agent 等同 codex，旧客户端不带该字段仍按 codex 处理。 */
export type AgentKind = 'codex' | 'claude' | 'pi'

export function isAgentKind(x: unknown): x is AgentKind {
  return x === 'codex' || x === 'claude' || x === 'pi'
}

/** 解析可选 agent：缺省为 codex，显式但非法的值返回 null 让调用方报参数错误。 */
export function parseAgent(x: unknown): AgentKind | null {
  if (x === undefined) return 'codex'
  return isAgentKind(x) ? x : null
}

export type Hello = {
  t: 'hello'
  protocol: typeof PROTOCOL_VERSION
  token: string
  client: ClientInfo
}

export type Welcome = {
  t: 'welcome'
  protocol: typeof PROTOCOL_VERSION
  serverVersion: string
  pid: number
}

export type Req = { t: 'req'; id: number; method: string; params?: unknown }

export type ResOk = { t: 'res'; id: number; ok: true; result: unknown }
export type ResErr = { t: 'res'; id: number; ok: false; error: WireError }
export type Res = ResOk | ResErr

export type Evt = { t: 'evt'; name: string; payload: unknown }
export type CodexSend = { t: 'codex.send'; msg: unknown; agent?: AgentKind }
export type CodexRecv = { t: 'codex.recv'; seq: number | null; msg: unknown; agent?: AgentKind }
export type ErrorMsg = { t: 'error'; code: string | number; message: string }

export type ClientMessage = Hello | Req | CodexSend
export type ServerMessage = Welcome | Res | Evt | CodexRecv | ErrorMsg
export type WireMessage = ClientMessage | ServerMessage

export type FsEntry = { name: string; kind: 'dir' | 'file' | 'symlink' }

export interface ServerMethods extends WorkspaceMethods {
  ping: { params: void; result: { serverVersion: string; protocol: number } }
  'system.metrics': {
    params: void
    result: {
      cpuThreads: number
      cpuUsage: number | null
      memoryUsed: number
      memoryTotal: number
    }
  }
  'fs.home': { params: void; result: { path: string } }
  'fs.list': {
    params: { path: string; dirsOnly?: boolean }
    result: { path: string; entries: FsEntry[] }
  }
  'codex.open': {
    params: {
      codexPath?: string
      claudePath?: string
      piPath?: string
      codexHome?: string
      claudeConfigDir?: string
      agent?: AgentKind
    }
    result: {
      initialize: unknown
      lastSeq: number
      codexVersion?: string
      agentVersion?: string
      /** 旧版 server 只带其中一部分字段。 */
      capabilities?: Partial<AgentCapabilities> & Pick<AgentCapabilities, 'approvals' | 'rateLimits'>
    }
  }
  'codex.attach': {
    params: { sinceSeq: number; agent?: AgentKind }
    result: { lastSeq: number; truncated: boolean; accessModes?: boolean }
  }
  'codex.status': {
    params: { agent?: AgentKind }
    result: { running: boolean; pid?: number; activeTurns: number }
  }
  'server.shutdown': { params: { whenIdle: true } | void; result: Record<string, never> }
  /** 目标机记录的会话未读状态，电脑和手机共用；变化时广播 evt `thread.unread`。 */
  'thread.unread.list': { params: void; result: { threads: ThreadUnreadEntry[] } }
  'thread.unread.set': {
    params: { agent?: AgentKind; threadId: string; unread: boolean }
    result: { changed: boolean }
  }
}

export type ThreadUnreadEntry = { agent: AgentKind; threadId: string; at: number }
/** evt `thread.unread` 的负载：turn 完成时 daemon 自动标记未读，客户端查看后回写已读。 */
export type ThreadUnreadEvent = { agent: AgentKind; threadId: string; unread: boolean }

export type ServerMethod = keyof ServerMethods
export type ServerParams<M extends ServerMethod> = ServerMethods[M]['params']
export type ServerResult<M extends ServerMethod> = ServerMethods[M]['result']

export function parseClientMessage(x: unknown): ClientMessage | null {
  if (!isRecord(x)) return null
  switch (x.t) {
    case 'hello':
      if (x.protocol !== PROTOCOL_VERSION) return null
      if (!isString(x.token)) return null
      if (!isRecord(x.client) || !isString(x.client.name) || !isString(x.client.version)) {
        return null
      }
      return x as unknown as ClientMessage
    case 'req':
      if (!isNumber(x.id) || !isString(x.method)) return null
      return x as unknown as ClientMessage
    case 'codex.send':
      // msg 是 codex 的原始 JSON-RPC，形状由 codex 决定，这里只保证它是可转发的对象。
      if (!hasOwn(x, 'msg') || !isRecord(x.msg)) return null
      if (hasOwn(x, 'agent') && !isAgentKind(x.agent)) return null
      return x as unknown as ClientMessage
    default:
      return null
  }
}

export function parseServerMessage(x: unknown): ServerMessage | null {
  if (!isRecord(x)) return null
  switch (x.t) {
    case 'welcome':
      if (x.protocol !== PROTOCOL_VERSION) return null
      if (!isString(x.serverVersion) || !isNumber(x.pid)) return null
      return x as unknown as ServerMessage
    case 'res':
      if (!isNumber(x.id)) return null
      if (x.ok === true) return hasOwn(x, 'result') ? (x as unknown as ServerMessage) : null
      if (x.ok === false) return isErrorMessage(x.error) ? (x as unknown as ServerMessage) : null
      return null
    case 'evt':
      if (!isString(x.name) || !hasOwn(x, 'payload')) return null
      return x as unknown as ServerMessage
    case 'codex.recv':
      if (x.seq !== null && !isNumber(x.seq)) return null
      if (!hasOwn(x, 'seq') || !hasOwn(x, 'msg') || !isRecord(x.msg)) return null
      if (hasOwn(x, 'agent') && !isAgentKind(x.agent)) return null
      return x as unknown as ServerMessage
    case 'error':
      if (!isErrorMessage(x)) return null
      return x as unknown as ServerMessage
    default:
      return null
  }
}
