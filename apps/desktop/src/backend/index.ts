import { randomUUID } from 'node:crypto'
import type { BackendMethod } from '../shared/backendApi'
import { backendConfig } from './config'
import { BackendRouter, RouterError, type WirePort } from './router'
import {
  createTargetId,
  readTargets,
  removeTarget,
  upsertDirectTarget,
  upsertTarget,
  writeTargets,
} from './targetStore'
import { loadSecret, removeSecret, saveSecret } from './secretStore'
import { isDirectInput, validateDirectInput } from './directInput'
import { validateTargetInput } from './targetInput'
import { registerDataMethods } from './registerData'
import { registerMobileMethods } from './registerMobile'
import { registerSettingsMethods } from './registerSettings'
import { registerTargetMethods } from './registerTargets'

export const router = new BackendRouter()

router.register('targets.list', () => readTargets(backendConfig.userData))

router.register('targets.save', async (params) => {
  if (isDirectInput(params)) {
    const direct = validateDirectInput(params)
    const current = await readTargets(backendConfig.userData)
    const { targets, target } = upsertDirectTarget(current, direct, `direct-${randomUUID()}`)
    if (direct.token) {
      // 只更新 token，保留同 id 下可能存在的其他凭据字段。
      const saved = await loadSecret(target.id).catch(() => null)
      await saveSecret(target.id, { ...(saved ?? {}), token: direct.token })
    }
    await writeTargets(backendConfig.userData, targets)
    return target
  }
  const input = validateTargetInput(params)
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
registerSettingsMethods(router)
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
