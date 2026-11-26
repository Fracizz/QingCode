import { hostname } from 'node:os'
import { decodeDirectCode } from '@qn/protocol'
import {
  LOCAL_TARGET,
  type SshTarget,
  type BackendEvent,
  type BackendEvents,
  type Target,
} from '../shared/backendApi'
import { backendConfig } from './config'
import { redactToken } from './remoteCommands'
import { RouterError, type BackendRouter } from './router'
import { validateTargetInput } from './targetInput'
import { readTargets, setSshDirect, writeTargets } from './targetStore'
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

function readCredentials(params: Record<string, unknown>): TargetCredentials {
  const credentials: TargetCredentials = {}
  const password = optionalString(params.password, 'password')
  const passphrase = optionalString(params.passphrase, 'passphrase')
  if (password !== undefined) credentials.password = password
  if (passphrase !== undefined) credentials.passphrase = passphrase
  return credentials
}

const DEFAULT_DIRECT_LISTEN = '47390'

async function requireSshTarget(id: string): Promise<SshTarget> {
  const target = (await readTargets(backendConfig.userData)).find((item) => item.id === id)
  if (!target) throw new RouterError('not_found', `目标 ${id} 不存在`)
  if (target.kind !== 'ssh') throw new RouterError('invalid_params', '只有 SSH 目标可以开启直连加速')
  return target
}

function connectFailed(err: unknown): RouterError {
  return new RouterError('connect_failed', redactToken(err instanceof Error ? err.message : String(err)))
}

/** 直连授权名用本机名，便于在远端 `direct status` 里辨认和撤销。 */
function grantName(): string {
  return `QingCode Next @ ${hostname()}`.slice(0, 80)
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
    const credentials = readCredentials(params)
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

  router.register('target.test', async (params) => {
    const input = validateTargetInput(params)
    const credentials = readCredentials(params)
    try {
      return await manager.test({ ...input, id: input.id ?? '', kind: 'ssh' }, credentials)
    } catch (err) {
      throw new RouterError('connect_failed', redactToken(err instanceof Error ? err.message : String(err)))
    }
  })

  router.register('target.enableDirect', async (params) => {
    const id = requireId(params)
    if (!isRecord(params)) throw new RouterError('invalid_params', '参数无效')
    const target = await requireSshTarget(id)
    const listen = optionalString(params.listen, 'listen')?.trim() || DEFAULT_DIRECT_LISTEN
    const dialHost = optionalString(params.host, 'host')?.trim() || target.host
    const enable = ['direct', 'enable', '--listen', listen, ...(params.allowPublic === true ? ['--allow-public'] : [])]
    const grant = ['direct', 'grant', '--name', grantName(), '--host', dialHost]
    let results: Array<Record<string, unknown>>
    try {
      // 同一 SSH 会话里先开监听再签发授权；之后 SSH 可断开，直连由远端 daemon 常驻提供。
      results = await manager.remoteServer(target, readCredentials(params), [enable, grant])
    } catch (err) {
      throw connectFailed(err)
    }
    const granted = results[1]
    const code = typeof granted?.code === 'string' ? decodeDirectCode(granted.code) : null
    const grantId = typeof granted?.grantId === 'string' ? granted.grantId : ''
    if (!code || !grantId) throw new RouterError('connect_failed', '远端未返回有效的直连授权')
    // 旧授权留着没有意义且多一个可用凭据，换新后顺手撤销（失败不影响开启）。
    const previous = target.direct?.grantId
    await manager.setDirectToken(id, code.token)
    const updated = setSshDirect(await readTargets(backendConfig.userData), id, {
      host: dialHost,
      port: code.port,
      fingerprint: code.fingerprint,
      grantId,
    })
    if (!updated) throw new RouterError('not_found', `目标 ${id} 不存在`)
    await writeTargets(backendConfig.userData, updated.targets)
    manager.updateTarget(updated.target)
    if (previous && previous !== grantId) {
      void manager.remoteServer(updated.target, readCredentials(params), [['direct', 'revoke', '--id', previous]])
        .catch(() => undefined)
    }
    return updated.target
  })

  router.register('target.disableDirect', async (params) => {
    const id = requireId(params)
    if (!isRecord(params)) throw new RouterError('invalid_params', '参数无效')
    const target = await requireSshTarget(id)
    const grantId = target.direct?.grantId
    if (grantId) {
      try {
        // 只撤销本机授权：远端监听可能还服务着其它客户端，由远端自行 `direct disable`。
        await manager.remoteServer(target, readCredentials(params), [['direct', 'revoke', '--id', grantId]])
      } catch (err) {
        // 授权已不存在（远端被重置）时照常清除本地配置。
        const message = err instanceof Error ? err.message : String(err)
        if (!message.includes('授权不存在')) throw connectFailed(err)
      }
    }
    await manager.setDirectToken(id, undefined)
    const updated = setSshDirect(await readTargets(backendConfig.userData), id, undefined)
    if (!updated) throw new RouterError('not_found', `目标 ${id} 不存在`)
    await writeTargets(backendConfig.userData, updated.targets)
    manager.updateTarget(updated.target)
    return updated.target
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
