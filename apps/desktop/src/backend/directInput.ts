import { isValidFingerprint, normalizeFingerprint } from '@qn/protocol'
import type { DirectTargetInput } from '../shared/backendApi'
import { RouterError } from './router'

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

export function isDirectInput(params: unknown): params is DirectTargetInput {
  return isRecord(params) && params.kind === 'direct'
}

export function validateDirectInput(params: unknown): DirectTargetInput {
  if (!isRecord(params) || params.kind !== 'direct') throw new RouterError('invalid_params', '直连参数无效')
  const { name, host, port, fingerprint, token } = params
  if (typeof name !== 'string' || name.trim() === '') throw new RouterError('invalid_params', '名称不能为空')
  if (typeof host !== 'string' || host.trim() === '') throw new RouterError('invalid_params', '主机不能为空')
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RouterError('invalid_params', '端口无效')
  }
  if (typeof fingerprint !== 'string' || !isValidFingerprint(fingerprint)) {
    throw new RouterError('invalid_params', '证书指纹无效')
  }
  if (token !== undefined && (typeof token !== 'string' || token.length < 16)) {
    throw new RouterError('invalid_params', '连接令牌无效')
  }
  const id = typeof params.id === 'string' && params.id !== '' && params.id !== 'local' ? params.id : undefined
  if (!id && token === undefined) throw new RouterError('invalid_params', '新建直连需要连接令牌')
  return {
    ...(id ? { id } : {}),
    kind: 'direct',
    name: name.trim(),
    host: host.trim(),
    port,
    fingerprint: normalizeFingerprint(fingerprint),
    ...(typeof token === 'string' ? { token } : {}),
  }
}
