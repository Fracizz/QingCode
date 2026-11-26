import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SavedSecret } from '../shared/backendApi'
import { backendConfig } from './config'

const SECRETS_FILE = 'secrets.json'
const CIPHER_TIMEOUT_MS = 5000

export type StoredSecret = SavedSecret

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

export type SecretCipher = {
  encrypt(text: string): Promise<string>
  decrypt(encoded: string): Promise<string>
}

type SecretResult =
  | { type: 'secret.result'; id: string; ok: true; value: string }
  | { type: 'secret.result'; id: string; ok: false; error: string }

// 只依赖 parentPort 的最小接口，便于单测注入假 main。
export type ParentPortLike = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
}

function isSecretResult(x: unknown): x is SecretResult {
  if (!isRecord(x) || x.type !== 'secret.result' || typeof x.id !== 'string') return false
  if (x.ok === true) return typeof x.value === 'string'
  if (x.ok === false) return typeof x.error === 'string'
  return false
}

export function createParentPortCipher(port?: ParentPortLike | null): SecretCipher {
  const target = port ?? (process.parentPort as unknown as ParentPortLike | undefined) ?? null
  const pending = new Map<string, {
    resolve: (value: string) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  let listening = false

  const ensureListener = (): void => {
    if (!target || listening) return
    listening = true
    target.on('message', (e) => {
      const data = e.data
      if (!isSecretResult(data)) return
      const entry = pending.get(data.id)
      if (!entry) return
      pending.delete(data.id)
      clearTimeout(entry.timer)
      if (data.ok) entry.resolve(data.value)
      else entry.reject(new Error(data.error || '凭据服务返回错误'))
    })
  }

  const request = (
    type: 'secret.encrypt' | 'secret.decrypt',
    payload: { text?: string; encoded?: string }
  ): Promise<string> => new Promise((resolve, reject) => {
    if (!target) {
      reject(new Error('凭据服务不可用（需运行在 Electron utilityProcess 中）'))
      return
    }
    ensureListener()
    const id = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('凭据服务响应超时'))
    }, CIPHER_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    try {
      target.postMessage({ type, id, ...payload })
    } catch {
      pending.delete(id)
      clearTimeout(timer)
      reject(new Error('凭据服务不可用'))
    }
  })

  return {
    encrypt: (text) => request('secret.encrypt', { text }),
    decrypt: (encoded) => request('secret.decrypt', { encoded }),
  }
}

let sharedCipher: SecretCipher | null = null

// 单例避免每次请求都往 parentPort 上叠加一个监听器。
export function defaultSecretCipher(): SecretCipher {
  sharedCipher ??= createParentPortCipher()
  return sharedCipher
}

export function parseSecretStore(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key !== '' && typeof value === 'string' && value !== '') result[key] = value
  }
  return result
}

export function withSecret(
  store: Readonly<Record<string, string>>,
  targetId: string,
  encoded: string
): Record<string, string> {
  return { ...store, [targetId]: encoded }
}

export function withoutSecret(
  store: Readonly<Record<string, string>>,
  targetId: string
): Record<string, string> {
  const next = { ...store }
  delete next[targetId]
  return next
}

// 明文可能来自 safeStorage 或旧版 DPAPI；只保留非空字符串字段，异常内容一律丢弃。
export function parseStoredSecret(raw: unknown): StoredSecret | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      return null
    }
  }
  if (!isRecord(value)) return null
  const secret: StoredSecret = {}
  if (typeof value.password === 'string' && value.password !== '') secret.password = value.password
  if (typeof value.passphrase === 'string' && value.passphrase !== '') secret.passphrase = value.passphrase
  if (typeof value.token === 'string' && value.token !== '') secret.token = value.token
  if (typeof value.directToken === 'string' && value.directToken !== '') secret.directToken = value.directToken
  return secret.password || secret.passphrase || secret.token || secret.directToken ? secret : null
}

export function serializeStoredSecret(secret: StoredSecret): string {
  const parsed = parseStoredSecret(secret)
  return JSON.stringify(parsed ?? {})
}

export async function readSecretStore(userData: string): Promise<Record<string, string>> {
  try {
    const text = await readFile(join(userData, SECRETS_FILE), 'utf8')
    return parseSecretStore(JSON.parse(text) as unknown)
  } catch {
    return {}
  }
}

export async function writeSecretStore(
  userData: string,
  store: Readonly<Record<string, string>>
): Promise<void> {
  const file = join(userData, SECRETS_FILE)
  const tmp = `${file}.tmp`
  await mkdir(userData, { recursive: true })
  await writeFile(tmp, JSON.stringify(parseSecretStore(store), null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

export type SecretOptions = {
  userData?: string
  cipher?: SecretCipher
}

export async function loadSecret(
  targetId: string,
  options: SecretOptions = {}
): Promise<StoredSecret | null> {
  if (!targetId) return null
  const userData = options.userData ?? backendConfig.userData
  const cipher = options.cipher ?? defaultSecretCipher()
  const store = await readSecretStore(userData)
  const encoded = store[targetId]
  if (!encoded) return null
  const text = await cipher.decrypt(encoded)
  return parseStoredSecret(text)
}

export async function saveSecret(
  targetId: string,
  secret: StoredSecret,
  options: SecretOptions = {}
): Promise<void> {
  if (!targetId) return
  const parsed = parseStoredSecret(secret)
  if (!parsed) {
    await removeSecret(targetId, options)
    return
  }
  const userData = options.userData ?? backendConfig.userData
  const cipher = options.cipher ?? defaultSecretCipher()
  const encoded = await cipher.encrypt(serializeStoredSecret(parsed))
  const store = await readSecretStore(userData)
  await writeSecretStore(userData, withSecret(store, targetId, encoded))
}

export async function removeSecret(
  targetId: string,
  options: SecretOptions = {}
): Promise<void> {
  if (!targetId) return
  const userData = options.userData ?? backendConfig.userData
  const store = await readSecretStore(userData)
  if (!(targetId in store)) return
  await writeSecretStore(userData, withoutSecret(store, targetId))
}
