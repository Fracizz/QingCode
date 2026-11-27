import { hasOwn, isRecord } from './guards'

export type JsonRpcId = number | string
export type JsonRpcRequest = { id: JsonRpcId; method: string; params?: unknown }
export type JsonRpcNotification = { method: string; params?: unknown }
export type JsonRpcResponse =
  | { id: JsonRpcId; result: unknown }
  | { id: JsonRpcId; error: { code: number; message: string; data?: unknown } }
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export type JsonRpcKind = 'request' | 'notification' | 'response' | 'invalid'

function isId(x: unknown): x is JsonRpcId {
  return typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))
}

function isRpcError(x: unknown): boolean {
  return (
    isRecord(x) &&
    typeof x.code === 'number' &&
    Number.isFinite(x.code) &&
    typeof x.message === 'string'
  )
}

/**
 * codex app-server 的消息不带 jsonrpc 字段，标准 JSON-RPC 2.0 带；两种都按同一套规则识别。
 * 额外字段一律忽略，避免 codex 升级后新增字段导致中继误判。
 */
export function classifyJsonRpc(msg: unknown): JsonRpcKind {
  if (!isRecord(msg)) return 'invalid'
  if (hasOwn(msg, 'jsonrpc') && msg.jsonrpc !== '2.0') return 'invalid'

  const hasId = hasOwn(msg, 'id')
  const hasMethod = hasOwn(msg, 'method')
  const hasResult = hasOwn(msg, 'result')
  const hasError = hasOwn(msg, 'error')

  if (hasId && !isId(msg.id)) return 'invalid'
  if (hasMethod && typeof msg.method !== 'string') return 'invalid'
  if (hasError && !isRpcError(msg.error)) return 'invalid'

  if (hasMethod && !hasResult && !hasError) return hasId ? 'request' : 'notification'
  if (!hasMethod && hasId && hasResult !== hasError) return 'response'
  return 'invalid'
}

export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  return classifyJsonRpc(msg) === 'request'
}

export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  return classifyJsonRpc(msg) === 'notification'
}

export function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  return classifyJsonRpc(msg) === 'response'
}
