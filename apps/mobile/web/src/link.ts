// 连接信息的格式是电脑端与手机端共用的线协议；不引入 Node 依赖，便于整文件复制到 WebView。
export type PairingInfo = {
  host: string
  port: number
  fp: string
  name: string
  code: string
}

export type ConnectionInfo = { text: string; link: string }

export type PairingDraft = {
  name: string
  host: string
  port: number
  fp: string
  code: string
}

export const PAIR_SCHEME = 'qingcode-next://pair'
// i18n-ignore: 与电脑端共用的连接信息文本，手机端仅 mock 与单测生成
export const CONNECTION_INFO_TITLE = 'QingCode Next 手机连接'
export const DEFAULT_PAIRING_PORT = 38500

const PAIR_MARKER = `${PAIR_SCHEME}?`
const LINK_TAIL = /^[^\s<>"'\x60>，。；、）】」》]+/u
const TRAILING_PUNCTUATION = /[.,，。;；、)）\]】」》>»"'\x60]+$/u
const HASH_64 = /^[0-9a-f]{64}$/i
const DOMAIN_LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/

/** 指纹固定为 DER SHA-256 的 64 位小写 hex；兼容复制时带冒号或空格的形式。 */
export function normalizeFingerprint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.trim().replace(/:/g, '').replace(/\s+/g, '')
  return HASH_64.test(cleaned) ? cleaned.toLowerCase() : null
}

export function parsePort(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : null
}

function isIpv6(host: string): boolean {
  if (!host.includes(':') || !/^[0-9a-fA-F:.]+$/.test(host)) return false
  try {
    // URL 对 IPv6 的压缩写法做严格解析，避免把任意冒号串当作地址。
    const parsed = new URL(`http://[${host}]/`)
    return parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
  } catch {
    return false
  }
}

/** 主机允许 IPv4、IPv6（可带方括号）、域名；frp 场景不能用主机名做身份校验。 */
export function isValidHost(raw: string): boolean {
  const host = raw.trim()
  if (host === '' || host.length > 253) return false
  const bracketed = /^\[([0-9a-fA-F:.]+)\]$/.exec(host)
  if (bracketed) return isIpv6(bracketed[1] ?? '')
  if (host.startsWith('[') || host.endsWith(']')) return false
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) return false
  if (host.includes(':')) return isIpv6(host)
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((part) => Number(part) <= 255)
  }
  return host.split('.').every((label) => DOMAIN_LABEL.test(label))
}

/** 显示用地址：IPv6 必须加方括号，避免与端口分隔符混淆。 */
export function formatAddress(host: string, port?: number | null): string {
  const value = host.trim()
  const suffix = port === null || port === undefined ? '' : `:${port}`
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close < 0) return `${value}${suffix}`
    return value.slice(close + 1).startsWith(':') ? value : `${value}${suffix}`
  }
  if (value.includes(':')) return `[${value}]${suffix}`
  return `${value}${suffix}`
}

/** 用户手动改地址时接受 "host:port" 或单独 host；port 为 null 表示沿用旧端口。 */
export function parseAddress(raw: string): { host: string; port: number | null } | null {
  const text = raw.trim()
  if (!text) return null
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(text)
  if (bracketed) {
    const inner = bracketed[1] ?? ''
    if (!isIpv6(inner)) return null
    const portText = bracketed[2]
    if (portText === undefined) return { host: `[${inner}]`, port: null }
    const port = parsePort(portText)
    return port === null ? null : { host: `[${inner}]`, port }
  }
  if (isValidHost(text)) return { host: text, port: null }
  const colon = text.lastIndexOf(':')
  if (colon >= 0 && /^\d{1,5}$/.test(text.slice(colon + 1))) {
    const port = parsePort(text.slice(colon + 1))
    const host = text.slice(0, colon)
    if (port !== null && !host.includes(':') && isValidHost(host)) return { host, port }
  }
  return null
}

function encodeParam(value: string): string {
  // URLSearchParams 不转义英文句点；密码末尾的句点可能与聊天软件追加的标点混淆，统一百分号编码。
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\./g, '%2E')
}

export function buildPairingLink(info: PairingInfo): string {
  const query = [
    'v=1',
    `host=${encodeParam(info.host.trim())}`,
    `port=${encodeParam(String(info.port))}`,
    `fp=${encodeParam(normalizeFingerprint(info.fp) ?? info.fp.trim())}`,
    `name=${encodeParam(info.name.trim())}`,
    `code=${encodeParam(info.code)}`,
  ].join('&')
  return `${PAIR_SCHEME}?${query}`
}

export function buildConnectionInfo(info: PairingInfo): ConnectionInfo {
  const link = buildPairingLink(info)
  const text = [
    CONNECTION_INFO_TITLE,
    `电脑：${info.name.trim() || '未命名电脑'}`, // i18n-ignore: 连接信息文本
    `地址：${formatAddress(info.host, info.port)}`, // i18n-ignore: 连接信息文本
    '在 QingCode Next 手机版「添加连接」中粘贴即可导入：', // i18n-ignore: 连接信息文本
    link,
  ].join('\n')
  return { text, link }
}

function parseCandidate(link: string): PairingInfo | null {
  if (!link.toLowerCase().startsWith(PAIR_MARKER)) return null
  const queryAt = link.indexOf('?')
  if (queryAt < 0) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(link.slice(queryAt + 1))
  } catch {
    return null
  }
  const version = params.get('v')
  if (version !== null && version !== '1') return null
  const host = params.get('host')?.trim() ?? ''
  if (!isValidHost(host)) return null
  const port = parsePort(params.get('port'))
  if (port === null) return null
  const fp = normalizeFingerprint(params.get('fp'))
  if (fp === null) return null
  const code = params.get('code')?.trim() ?? ''
  if (!code || code.length > 128 || /[\u0000-\u001f\u007f]/.test(code)) return null
  const name = params.get('name')?.trim() || '未命名电脑' // i18n-ignore: 默认名按原文保存，展示时翻译
  return { host, port, fp, name, code }
}

/** 从聊天软件转发的任意文本里提取第一条连接信息；链接之后的文字不能污染字段。 */
export function parsePairingLink(raw: unknown): PairingInfo | null {
  if (typeof raw !== 'string') return null
  const lower = raw.toLowerCase()
  let from = 0
  for (;;) {
    const start = lower.indexOf(PAIR_MARKER, from)
    if (start < 0) return null
    const matched = LINK_TAIL.exec(raw.slice(start))?.[0] ?? ''
    const stripped = matched.replace(TRAILING_PUNCTUATION, '')
    const candidates = stripped === matched ? [matched] : [stripped, matched]
    for (const candidate of candidates) {
      const parsed = parseCandidate(candidate)
      if (parsed) return parsed
    }
    from = start + PAIR_MARKER.length
  }
}

/** 配对密码 6–20 位、区分大小写；空格与控制字符不作为密码内容，避免复制时被裁剪。 */
export function isValidPairingCode(code: string): boolean {
  return code.length >= 6 && code.length <= 20 && !/[\s\u0000-\u001f\u007f]/.test(code)
}

export function draftFromInfo(info: PairingInfo): PairingDraft {
  return { name: info.name, host: info.host, port: info.port, fp: info.fp, code: info.code }
}
