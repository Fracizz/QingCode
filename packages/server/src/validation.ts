import { timingSafeEqual } from 'node:crypto'
import { PROTOCOL_VERSION } from '@qn/protocol'

export type HelloCheck =
  | { ok: true; client: { name: string; version: string } }
  | { ok: false; code: 'protocol' | 'auth'; message: string }

export interface HelloRule {
  /** 本机连接：与 daemon 主 token 常数时间比较 */
  token?: string
  /** 直连：由授权表判定；提供时优先于 token */
  authorize?: (token: unknown) => boolean
  protocol?: number
}

/** 首帧校验独立于 parseClientMessage：后者对 protocol≠1 的 hello 直接返回 null，无法区分错误码。 */
export function checkHello(raw: unknown, rule: HelloRule): HelloCheck {
  if (!isRecord(raw) || raw.t !== 'hello') {
    return protocolError('首帧必须是 hello')
  }
  const expectedProtocol = rule.protocol ?? PROTOCOL_VERSION
  if (raw.protocol !== expectedProtocol) {
    return protocolError(`协议版本不符，需要 ${expectedProtocol}`)
  }
  const authorized = rule.authorize
    ? rule.authorize(raw.token)
    : typeof raw.token === 'string' && rule.token !== undefined && tokensEqual(raw.token, rule.token)
  if (!authorized) {
    return { ok: false, code: 'auth', message: 'token 校验失败' }
  }
  const client = raw.client
  if (!isRecord(client) || typeof client.name !== 'string' || typeof client.version !== 'string') {
    return protocolError('hello.client 不完整')
  }
  return { ok: true, client: { name: client.name, version: client.version } }
}

function protocolError(message: string): HelloCheck {
  return { ok: false, code: 'protocol', message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}
