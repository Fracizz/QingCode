import type { SshAuth, SshTargetInput } from '../shared/backendApi'
import { RouterError } from './router'

// 保存与连接测试共用同一套参数校验。

function parseAuth(auth: SshAuth): SshAuth {
  if (!auth || typeof auth !== 'object') {
    throw new RouterError('invalid_params', '认证方式无效')
  }
  if (auth.kind === 'password' || auth.kind === 'agent') return { kind: auth.kind }
  if (auth.kind === 'key' && typeof auth.keyPath === 'string' && auth.keyPath !== '') {
    return { kind: 'key', keyPath: auth.keyPath }
  }
  throw new RouterError('invalid_params', '认证方式无效')
}

export function validateTargetInput(params: SshTargetInput): SshTargetInput {
  if (!params || typeof params !== 'object') {
    throw new RouterError('invalid_params', '连接参数无效')
  }
  const { name, host, port, username } = params
  if (typeof name !== 'string' || name.trim() === '') {
    throw new RouterError('invalid_params', '名称不能为空')
  }
  if (typeof host !== 'string' || host.trim() === '') {
    throw new RouterError('invalid_params', '主机不能为空')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RouterError('invalid_params', '端口无效')
  }
  if (typeof username !== 'string' || username.trim() === '') {
    throw new RouterError('invalid_params', '用户名不能为空')
  }
  return {
    ...(typeof params.id === 'string' && params.id !== 'local' ? { id: params.id } : {}),
    name: name.trim(),
    host: host.trim(),
    port,
    username: username.trim(),
    auth: parseAuth(params.auth),
  }
}
