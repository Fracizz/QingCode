// 手机连接面板的校验与展示纯逻辑；规则与 backend/mobile/link.ts、settings.ts 保持一致。
// 后端会再次校验，这里只做即时反馈，避免渲染层反向依赖 backend 目录。
import type { MobileSettings, MobileSettingsInput } from '../../../shared/backendApi'

export type SettingsDraft = {
  enabled: boolean
  terminalEnabled: boolean
  port: string
  password: string
  publicAddresses: string[]
}

export type AddressOption = {
  value: string
  kind: 'lan' | 'public'
}

export type PatchResult =
  | { ok: true; patch: MobileSettingsInput }
  | { ok: false; error: string }

export type GatewayStatus = {
  label: string
  tone: 'muted' | 'warn' | 'ok' | 'danger'
  detail: string
}

const CONTROL = /[\s\u0000-\u001f\u007f]/u
const DOMAIN_LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/
const HEX = /^[0-9a-fA-F:.]+$/

export function parsePort(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : null
}

export function isValidPairingCode(code: string): boolean {
  return code.length >= 6 && code.length <= 20 && !CONTROL.test(code)
}

function isIpv6(host: string): boolean {
  if (!host.includes(':') || !HEX.test(host)) return false
  try {
    // 交给 URL 做严格解析，避免把任意冒号串当作 IPv6。
    const parsed = new URL(`http://[${host}]/`)
    return parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
  } catch {
    return false
  }
}

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

/** IPv6 必须带方括号，否则无法与端口分隔符区分。 */
export function formatAddress(host: string, port?: number): string {
  const value = host.trim()
  const suffix = port === undefined ? '' : `:${port}`
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close < 0) return `${value}${suffix}`
    return value.slice(close + 1).startsWith(':') ? value : `${value}${suffix}`
  }
  if (value.includes(':')) return `[${value}]${suffix}`
  return `${value}${suffix}`
}

function parseAddress(raw: string): { host: string; port: number | null } | null {
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
  const colon = text.lastIndexOf(':')
  if (colon >= 0 && /^\d{1,5}$/.test(text.slice(colon + 1))) {
    const port = parsePort(text.slice(colon + 1))
    const host = text.slice(0, colon)
    if (port !== null && isValidHost(host)) return { host, port }
  }
  if (!isValidHost(text)) return null
  return { host: text, port: null }
}

/** 对外地址必须含端口；返回后端同样会保存的规范化形式。 */
export function normalizePublicAddress(raw: string): string | null {
  const parsed = parseAddress(raw)
  if (!parsed || parsed.port === null) return null
  return formatAddress(parsed.host, parsed.port)
}

/** 指纹为 64 位 hex；按 4 位分组便于人工核对，同时容忍复制时带冒号或空格。 */
export function groupFingerprint(raw: string): string {
  const cleaned = raw.replace(/[:\s]/g, '').toLowerCase()
  if (!cleaned) return ''
  const groups: string[] = []
  for (let index = 0; index < cleaned.length; index += 4) {
    groups.push(cleaned.slice(index, index + 4))
  }
  return groups.join(' ')
}

export function buildAddressOptions(
  lanAddresses: readonly string[],
  publicAddresses: readonly string[]
): AddressOption[] {
  const seen = new Set<string>()
  const options: AddressOption[] = []
  const add = (raw: string, kind: AddressOption['kind']): void => {
    const value = normalizePublicAddress(raw)
    if (!value || seen.has(value.toLowerCase())) return
    seen.add(value.toLowerCase())
    options.push({ value, kind })
  }
  for (const value of lanAddresses) add(value, 'lan')
  for (const value of publicAddresses) add(value, 'public')
  return options
}

export function draftFromSettings(settings: MobileSettings): SettingsDraft {
  return {
    enabled: settings.enabled,
    terminalEnabled: settings.terminalEnabled === true,
    port: String(settings.port),
    password: '',
    publicAddresses: [...settings.publicAddresses],
  }
}

/** 只提交改动过的字段；密码留空表示沿用已保存的密码。 */
export function buildSettingsPatch(
  draft: SettingsDraft,
  settings: MobileSettings
): PatchResult {
  const port = parsePort(draft.port)
  if (port === null) return { ok: false, error: '端口需为 1–65535 的整数' }
  if (draft.password && !isValidPairingCode(draft.password)) {
    return { ok: false, error: '配对密码需为 6–20 位且不含空白字符' }
  }
  const addresses: string[] = []
  for (const raw of draft.publicAddresses) {
    const normalized = normalizePublicAddress(raw)
    if (normalized === null) {
      return { ok: false, error: `对外地址「${raw}」无效，需填 host:port` }
    }
    if (!addresses.includes(normalized)) addresses.push(normalized)
  }

  const patch: MobileSettingsInput = {}
  if (draft.enabled !== settings.enabled) patch.enabled = draft.enabled
  if (draft.terminalEnabled !== (settings.terminalEnabled === true)) patch.terminalEnabled = draft.terminalEnabled
  if (port !== settings.port) patch.port = port
  if (draft.password) patch.password = draft.password
  if (
    addresses.length !== settings.publicAddresses.length ||
    addresses.some((value, index) => value !== settings.publicAddresses[index])
  ) {
    patch.publicAddresses = addresses
  }
  return { ok: true, patch }
}

export function formatDeviceTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function gatewayStatus(settings: MobileSettings | null): GatewayStatus {
  if (!settings) return { label: '加载中', tone: 'muted', detail: '正在读取手机连接设置…' }
  if (settings.error) return { label: '启动失败', tone: 'danger', detail: settings.error }
  if (!settings.enabled) return { label: '已停用', tone: 'muted', detail: '启用后手机才能连接这台电脑。' }
  if (settings.running) return { label: '运行中', tone: 'ok', detail: '' }
  if (!settings.hasPassword) {
    return { label: '待设置密码', tone: 'warn', detail: '请先设置 6–20 位配对密码。' }
  }
  return { label: '未运行', tone: 'danger', detail: '网关未监听，请检查端口后重试启动。' }
}
