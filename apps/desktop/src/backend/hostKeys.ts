import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const KNOWN_HOSTS_FILE = 'known_hosts.json'

export type KnownHosts = Record<string, string>
export type HostKeyVerdict = 'match' | 'new' | 'changed'

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

export function hostKeyId(host: string, port: number): string {
  return `${host}:${port}`
}

/** OpenSSH 显示格式：SHA256 + 原始公钥的 base64 摘要（无填充）。 */
export function fingerprintFromKey(key: Uint8Array): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export function normalizeKnownHosts(raw: unknown): KnownHosts {
  if (!isRecord(raw)) return {}
  const result: KnownHosts = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0) result[key] = value
  }
  return result
}

export function checkHostKey(
  store: KnownHosts,
  host: string,
  port: number,
  fingerprint: string
): HostKeyVerdict {
  const previous = store[hostKeyId(host, port)]
  if (previous === undefined) return 'new'
  return previous === fingerprint ? 'match' : 'changed'
}

export function previousHostKey(store: KnownHosts, host: string, port: number): string | undefined {
  return store[hostKeyId(host, port)]
}

export function setHostKey(
  store: KnownHosts,
  host: string,
  port: number,
  fingerprint: string
): KnownHosts {
  return { ...store, [hostKeyId(host, port)]: fingerprint }
}

export async function readKnownHosts(userData: string): Promise<KnownHosts> {
  try {
    const text = await readFile(join(userData, KNOWN_HOSTS_FILE), 'utf8')
    return normalizeKnownHosts(JSON.parse(text) as unknown)
  } catch {
    // 文件缺失或损坏时按空库处理，后续第一次连接会重新弹指纹确认。
    return {}
  }
}

export async function writeKnownHosts(userData: string, store: KnownHosts): Promise<void> {
  const file = join(userData, KNOWN_HOSTS_FILE)
  const tmp = `${file}.tmp`
  await mkdir(userData, { recursive: true })
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}
