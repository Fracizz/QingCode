import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RouterError } from '../router'
import type { SecretCipher } from '../secretStore'
import { loadSecret, readSecretStore, saveSecret } from '../secretStore'
import {
  DEFAULT_PAIRING_PORT,
  formatAddress,
  isValidPairingCode,
  parseAddress,
  parsePort,
} from './link'

export const MOBILE_DIRECTORY_NAME = 'mobile'
export const PAIRING_SECRET_ID = 'mobile.pairing'

export type MobileStoredSettings = {
  enabled: boolean
  terminalEnabled?: boolean
  port: number
  publicAddresses: string[]
}

export type MobileSettingsPatch = {
  enabled?: boolean
  terminalEnabled?: boolean
  port?: number
  password?: string
  publicAddresses?: string[]
}

export type NetworkEntry = {
  address?: string
  family?: string | number
  internal?: boolean
}

export type NetworkInterfacesLike = Readonly<Record<string, readonly NetworkEntry[] | undefined>>

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const DEFAULT_MOBILE_SETTINGS: MobileStoredSettings = {
  enabled: false,
  port: DEFAULT_PAIRING_PORT,
  publicAddresses: [],
}

export function mobileDirectory(userData: string): string {
  return join(userData, MOBILE_DIRECTORY_NAME)
}

export function normalizePublicAddresses(values: readonly unknown[]): string[] | null {
  if (values.length > 32) return null
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') return null
    const parsed = parseAddress(value.trim())
    if (!parsed || parsed.port === null) return null
    const address = formatAddress(parsed.host, parsed.port)
    if (!result.includes(address)) result.push(address)
  }
  return result
}

export function parseSettings(raw: unknown): MobileStoredSettings {
  const record = isRecord(raw) ? raw : {}
  const addresses = Array.isArray(record.publicAddresses)
    ? normalizePublicAddresses(record.publicAddresses) ?? []
    : []
  return {
    enabled: record.enabled === true,
    ...(record.terminalEnabled === true ? { terminalEnabled: true } : {}),
    port: parsePort(record.port) ?? DEFAULT_MOBILE_SETTINGS.port,
    publicAddresses: addresses,
  }
}

export function validateSettingsPatch(raw: unknown): MobileSettingsPatch {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) throw new RouterError('invalid_params', '手机连接设置无效')
  const patch: MobileSettingsPatch = {}
  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') throw new RouterError('invalid_params', '启用开关必须是布尔值')
    patch.enabled = raw.enabled
  }
  if ('terminalEnabled' in raw) {
    if (typeof raw.terminalEnabled !== 'boolean') throw new RouterError('invalid_params', '手机终端开关必须是布尔值')
    patch.terminalEnabled = raw.terminalEnabled
  }
  if ('port' in raw) {
    const port = parsePort(raw.port)
    if (port === null) throw new RouterError('invalid_params', '端口必须是 1–65535 的整数')
    patch.port = port
  }
  if ('password' in raw) {
    if (typeof raw.password !== 'string' || !isValidPairingCode(raw.password)) {
      throw new RouterError('invalid_params', '配对密码需为 6–20 位且不含空白字符')
    }
    patch.password = raw.password
  }
  if ('publicAddresses' in raw) {
    if (!Array.isArray(raw.publicAddresses)) {
      throw new RouterError('invalid_params', '对外地址必须是 host:port 列表')
    }
    const addresses = normalizePublicAddresses(raw.publicAddresses)
    if (addresses === null) {
      throw new RouterError('invalid_params', '对外地址必须是有效的 host:port，最多 32 条')
    }
    patch.publicAddresses = addresses
  }
  return patch
}

/** os.networkInterfaces() 的非内部 IPv4，转换成手机可粘贴的 host:port。 */
export function lanAddressesFromInterfaces(
  interfaces: NetworkInterfacesLike,
  port: number
): string[] {
  const addresses = new Set<string>()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number | undefined
      const isIPv4 = family === 'IPv4' || family === 4 || String(family) === '4'
      if (!isIPv4 || entry.internal || !entry.address) continue
      addresses.add(formatAddress(entry.address, port))
    }
  }
  return [...addresses].sort()
}

export async function readSettings(directory: string): Promise<MobileStoredSettings> {
  try {
    const text = await readFile(join(directory, 'settings.json'), 'utf8')
    return parseSettings(JSON.parse(text) as unknown)
  } catch {
    return { ...DEFAULT_MOBILE_SETTINGS, publicAddresses: [] }
  }
}

export async function writeSettings(
  directory: string,
  settings: MobileStoredSettings
): Promise<void> {
  const normalized = parseSettings(settings)
  const file = join(directory, 'settings.json')
  const tmp = `${file}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
}

export class MobileSettingsStore {
  readonly directory: string

  constructor(
    private readonly userData: string,
    private readonly cipher: SecretCipher
  ) {
    this.directory = mobileDirectory(userData)
  }

  read(): Promise<MobileStoredSettings> {
    return readSettings(this.directory)
  }

  write(settings: MobileStoredSettings): Promise<void> {
    return writeSettings(this.directory, settings)
  }

  async hasPassword(): Promise<boolean> {
    const store = await readSecretStore(this.userData)
    return Boolean(store[PAIRING_SECRET_ID])
  }

  async getPassword(): Promise<string | null> {
    const secret = await loadSecret(PAIRING_SECRET_ID, {
      userData: this.userData,
      cipher: this.cipher,
    })
    const code = secret?.password
    return code && isValidPairingCode(code) ? code : null
  }

  async setPassword(code: string): Promise<void> {
    if (!isValidPairingCode(code)) {
      throw new RouterError('invalid_params', '配对密码需为 6–20 位且不含空白字符')
    }
    await saveSecret(PAIRING_SECRET_ID, { password: code }, {
      userData: this.userData,
      cipher: this.cipher,
    })
  }
}
