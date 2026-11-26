import { loadSecret, saveSecret } from './secretStore'
import type { TargetCredentials } from './types'

// T8 的 secretStore 负责 safeStorage 加解密；保留注入点便于单测替换与跨任务解耦。
export interface SecretProvider {
  loadSecret(targetId: string, userData?: string): Promise<TargetCredentials | null>
  saveSecret(targetId: string, credentials: TargetCredentials, userData?: string): Promise<void>
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const defaultProvider: SecretProvider = {
  loadSecret: (targetId, userData) => loadSecret(targetId, { ...(userData !== undefined ? { userData } : {}) }),
  saveSecret: (targetId, credentials, userData) =>
    saveSecret(targetId, credentials, { ...(userData !== undefined ? { userData } : {}) }),
}

let injected: SecretProvider | null = null

export function setSecretProvider(provider: SecretProvider): void {
  injected = provider
}

function sanitize(raw: unknown): TargetCredentials | null {
  if (!isRecord(raw)) return null
  const result: TargetCredentials = {}
  if (typeof raw.password === 'string' && raw.password !== '') result.password = raw.password
  if (typeof raw.passphrase === 'string' && raw.passphrase !== '') result.passphrase = raw.passphrase
  return Object.keys(result).length > 0 ? result : null
}

export async function loadTargetSecret(targetId: string, userData?: string): Promise<TargetCredentials | null> {
  const provider = injected ?? defaultProvider
  try {
    return sanitize(await provider.loadSecret(targetId, userData))
  } catch {
    // 凭据解密失败时按未提供处理，仍允许前端本次显式输入密码。
    return null
  }
}

export async function saveTargetSecret(
  targetId: string,
  credentials: TargetCredentials,
  userData?: string
): Promise<void> {
  const provider = injected ?? defaultProvider
  try {
    await provider.saveSecret(targetId, credentials, userData)
  } catch {
    // 加密存储不可用不应中断已经成功的连接。
  }
}
