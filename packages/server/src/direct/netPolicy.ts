import net from 'node:net'

// 直连默认只接受私网来源（参考 Orca `serve`：公网地址需显式 --allow-public）。
// frp/SSH 转发进来的连接在服务端看是 127.0.0.1，天然属于允许范围。

export type AddressClass = 'loopback' | 'private' | 'cgnat' | 'link-local' | 'public' | 'invalid'

/** 去掉 IPv6 zone 与 IPv4-mapped 前缀，便于统一判断。 */
export function normalizeRemoteAddress(raw: string): string {
  let text = raw.trim()
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text)
  return mapped?.[1] ?? text.toLowerCase()
}

function ipv4Parts(ip: string): number[] {
  return ip.split('.').map((part) => Number(part))
}

function classifyIpv4(ip: string): AddressClass {
  const [a = -1, b = -1] = ipv4Parts(ip)
  if (a === 127) return 'loopback'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  // Tailscale 等使用 100.64.0.0/10。
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'
  if (a === 169 && b === 254) return 'link-local'
  return 'public'
}

function classifyIpv6(ip: string): AddressClass {
  if (ip === '::1') return 'loopback'
  const head = Number.parseInt(ip.split(':')[0] || '0', 16)
  if (Number.isNaN(head)) return 'invalid'
  // fc00::/7 唯一本地地址（含 Tailscale fd7a:115c:a1e0::/48）。
  if ((head & 0xfe00) === 0xfc00) return 'private'
  if ((head & 0xffc0) === 0xfe80) return 'link-local'
  return 'public'
}

export function classifyAddress(raw: string): AddressClass {
  const ip = normalizeRemoteAddress(raw)
  const family = net.isIP(ip)
  if (family === 4) return classifyIpv4(ip)
  if (family === 6) return classifyIpv6(ip)
  return 'invalid'
}

export function isAllowedPeer(raw: string | undefined, allowPublic: boolean): boolean {
  if (!raw) return false
  const kind = classifyAddress(raw)
  if (kind === 'invalid') return false
  return kind !== 'public' || allowPublic
}
