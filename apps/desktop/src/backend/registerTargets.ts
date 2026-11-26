import {
  LOCAL_TARGET,
  type BackendEvent,
  type BackendEvents,
  type Target,
} from '../shared/backendApi'
import { backendConfig } from './config'
import { redactToken } from './remoteCommands'
import { RouterError, type BackendRouter } from './router'
import { readTargets } from './targetStore'
import { TargetManager } from './targets'
import type { BackendEmit, TargetCredentials } from './types'

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

function requireId(params: unknown): string {
  if (!isRecord(params) || typeof params.id !== 'string' || params.id === '') {
    throw new RouterError('invalid_params', '目标 id 无效')
  }
  return params.id
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new RouterError('invalid_params', `${field} 必须是字符串`)
  return value
}

export function registerTargetMethods(router: BackendRouter): void {
  const emit: BackendEmit = (name, payload) => {
    router.emit(name as BackendEvent, payload as BackendEvents[BackendEvent])
  }
  const manager = new TargetManager({
    ...backendConfig,
    emit,
    ...(process.env['QN_AUTO_ACCEPT_HOST_KEY'] === '1' ? { autoAcceptHostKey: true } : {}),
  })

  router.register('target.connect', async (params) => {
    const id = requireId(params)
    if (!isRecord(params)) throw new RouterError('invalid_params', '连接参数无效')
    const credentials: TargetCredentials = {}
    const password = optionalString(params.password, 'password')
    const passphrase = optionalString(params.passphrase, 'passphrase')
    if (password !== undefined) credentials.password = password
    if (passphrase !== undefined) credentials.passphrase = passphrase
    const remember = params.remember === true

    let target: Target | undefined
    if (id === 'local') target = LOCAL_TARGET
    else target = (await readTargets(backendConfig.userData)).find((item) => item.id === id)
    if (!target) throw new RouterError('not_found', `目标 ${id} 不存在`)

    // 渲染进程乐观地把 connecting 改成 ready；等首次握手结束再回包，避免假就绪闪烁。
    await manager.connect(target, credentials, remember).catch((err: unknown) => {
      emit('target.state', {
        id,
        state: 'error',
        detail: redactToken(err instanceof Error ? err.message : String(err)),
      })
    })
  })

  router.register('target.disconnect', (params) => {
    manager.disconnect(requireId(params))
  })

  router.register('hostKey.respond', (params) => {
    if (!isRecord(params) || typeof params.promptId !== 'string' || typeof params.accept !== 'boolean') {
      throw new RouterError('invalid_params', '指纹确认参数无效')
    }
    manager.respondHostKey(params.promptId, params.accept)
  })

  router.register('server.req', async (params) => {
    if (!isRecord(params) || typeof params.targetId !== 'string' || typeof params.method !== 'string' ||
        params.targetId === '' || params.method === '') {
      throw new RouterError('invalid_params', 'server.req 参数无效')
    }
    return manager.request(params.targetId, params.method, params.params)
  })

  router.register('codex.send', (params) => {
    if (!isRecord(params) || typeof params.targetId !== 'string' || params.targetId === '') {
      throw new RouterError('invalid_params', 'codex.send 参数无效')
    }
    manager.codexSend(params.targetId, params.msg, params.agent === 'claude' ? 'claude' : 'codex')
  })
}
