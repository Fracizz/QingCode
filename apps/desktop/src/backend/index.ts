import type { BackendMethod, SshAuth, SshTargetInput } from '../shared/backendApi'
import { backendConfig } from './config'
import { BackendRouter, RouterError, type WirePort } from './router'
import {
  createTargetId,
  readTargets,
  removeTarget,
  upsertTarget,
  writeTargets,
} from './targetStore'
import { removeSecret } from './secretStore'
import { registerDataMethods } from './registerData'
import { registerMobileMethods } from './registerMobile'
import { registerTargetMethods } from './registerTargets'

export const router = new BackendRouter()

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

function validateInput(params: SshTargetInput): SshTargetInput {
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

router.register('targets.list', () => readTargets(backendConfig.userData))

router.register('targets.save', async (params) => {
  const input = validateInput(params)
  const current = await readTargets(backendConfig.userData)
  const { targets, target } = upsertTarget(current, input, createTargetId())
  await writeTargets(backendConfig.userData, targets)
  return target
})

router.register('targets.remove', async ({ id }) => {
  if (!id || id === 'local') {
    throw new RouterError('invalid_params', '不能删除本机目标')
  }
  const current = await readTargets(backendConfig.userData)
  await writeTargets(backendConfig.userData, removeTarget(current, id))
  // 连接删除后不应留下可解密的旧凭据。
  await removeSecret(id).catch(() => undefined)
})

const notImplemented: BackendMethod[] = [
  'target.connect',
  'target.forgetSecret',
  'projects.list',
  'projects.save',
  'projects.remove',
  'legacy.detect',
  'legacy.import',
  'target.disconnect',
  'hostKey.respond',
  'server.req',
  'codex.send',
]
// 各模块在自己的文件里注册，避免并行开发时同时改本文件。
registerTargetMethods(router)
registerDataMethods(router)
registerMobileMethods(router)
router.registerNotImplemented(notImplemented)

function adaptPort(port: Electron.MessagePortMain): WirePort {
  return {
    postMessage: (message) => port.postMessage(message),
    on: (event, listener) => port.on(event, (e) => listener({ data: e.data })),
    start: () => port.start(),
    close: () => port.close(),
  }
}

// main 每次建通道都会发一个 port；多次重建时由 router 替换旧 port。
const parent = process.parentPort
if (parent) {
  parent.on('message', (event) => {
    const data: unknown = event.data
    if (!data || typeof data !== 'object' || (data as { type?: unknown }).type !== 'port') return
    const port = event.ports[0]
    if (port) router.attachPort(adaptPort(port))
  })
}
