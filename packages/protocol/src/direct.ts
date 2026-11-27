// 服务端直连的连接码：`qn-direct:` + base64url(JSON)。
// 由 `qn-server.cjs serve` 打印，桌面端粘贴导入；含 token，按密码对待。

export const DIRECT_CODE_PREFIX = 'qn-direct:'

export type DirectInfo = {
  v: 1
  /** 服务端认为可用的地址（局域网 IPv4 等），导入时可改 */
  hosts: string[]
  port: number
  token: string
  /** TLS 证书 DER 的 SHA-256，小写十六进制 */
  fingerprint: string
  /** 服务端主机名，仅用于默认名称 */
  name?: string
}

const HEX64 = /^[0-9a-f]{64}$/

export function normalizeFingerprint(raw: string): string {
  return raw.replace(/[:\s]/g, '').toLowerCase()
}

export function isValidFingerprint(raw: string): boolean {
  return HEX64.test(normalizeFingerprint(raw))
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function encodeDirectCode(info: DirectInfo): string {
  return DIRECT_CODE_PREFIX + toBase64Url(JSON.stringify(info))
}

/** 解析失败返回 null；允许前后空白与换行（从终端复制时常带上）。 */
export function decodeDirectCode(code: string): DirectInfo | null {
  const text = code.replace(/\s+/g, '')
  if (!text.startsWith(DIRECT_CODE_PREFIX)) return null
  let raw: unknown
  try {
    raw = JSON.parse(fromBase64Url(text.slice(DIRECT_CODE_PREFIX.length)))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const x = raw as Record<string, unknown>
  if (x.v !== 1) return null
  if (typeof x.port !== 'number' || !Number.isInteger(x.port) || x.port < 1 || x.port > 65535) return null
  if (typeof x.token !== 'string' || x.token.length < 16) return null
  if (typeof x.fingerprint !== 'string' || !isValidFingerprint(x.fingerprint)) return null
  const hosts = Array.isArray(x.hosts) ? x.hosts.filter((h): h is string => typeof h === 'string' && h !== '') : []
  return {
    v: 1,
    hosts,
    port: x.port,
    token: x.token,
    fingerprint: normalizeFingerprint(x.fingerprint),
    ...(typeof x.name === 'string' && x.name !== '' ? { name: x.name } : {}),
  }
}
