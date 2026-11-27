import { loadSecret, parseStoredSecret, saveSecret } from './secretStore'
import type { TargetCredentials } from './types'

// T8 的 secretStore 负责 safeStorage 加解密；保留注入点便于单测替换与跨任务解耦。
export interface SecretProvider {
  loadSecret(targetId: string, userData?: string): Promise<TargetCredentials | null>
  saveSecret(targetId: string, credentials: TargetCredentials, userData?: string): Promise<void>
}

const defaultProvider: SecretProvider = {
  loadSecret: (targetId, userData) => loadSecret(targetId, { ...(userData !== undefined ? { userData } : {}) }),
  saveSecret: (targetId, credentials, userData) =>
    saveSecret(targetId, credentials, { ...(userData !== undefined ? { userData } : {}) }),
}

let injected: SecretProvider | null = null

export function setSecretProvider(provider: SecretProvider): void {
  injected = provider
}

export async function loadTargetSecret(targetId: string, userData?: string): Promise<TargetCredentials | null> {
  const provider = injected ?? defaultProvider
  try {
    return parseStoredSecret(await provider.loadSecret(targetId, userData))
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
  await (injected ?? defaultProvider).saveSecret(targetId, credentials, userData)
}
