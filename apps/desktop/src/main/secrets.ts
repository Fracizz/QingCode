import { safeStorage, utilityProcess } from 'electron'

type BackendChild = ReturnType<typeof utilityProcess.fork>

type SecretRequest =
  | { type: 'secret.encrypt'; id: string; text: string }
  | { type: 'secret.decrypt'; id: string; encoded: string }

type SecretResult =
  | { type: 'secret.result'; id: string; ok: true; value: string }
  | { type: 'secret.result'; id: string; ok: false; error: string }

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

function isSecretRequest(x: unknown): x is SecretRequest {
  if (!isRecord(x) || typeof x.id !== 'string') return false
  if (x.type === 'secret.encrypt') return typeof x.text === 'string'
  if (x.type === 'secret.decrypt') return typeof x.encoded === 'string'
  return false
}

// safeStorage 只在主进程可用；backend 经 parentPort 请求加解密，主进程不落盘、不记录明文。
export function registerSecretHandlers(child: BackendChild): void {
  child.on('message', (message: unknown) => {
    if (!isSecretRequest(message)) return
    let result: SecretResult
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('unavailable')
      const value = message.type === 'secret.encrypt'
        ? safeStorage.encryptString(message.text).toString('base64')
        : safeStorage.decryptString(Buffer.from(message.encoded, 'base64'))
      result = { type: 'secret.result', id: message.id, ok: true, value }
    } catch {
      // 原始异常可能带明文/密文，统一换成不含内容的错误。
      result = {
        type: 'secret.result',
        id: message.id,
        ok: false,
        error: '凭据加解密失败或系统加密服务不可用',
      }
    }
    try {
      child.postMessage(result)
    } catch {
      // 子进程已退出时无需回包。
    }
  })
}
