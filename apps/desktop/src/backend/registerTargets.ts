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
import { registerPluginMethods } from './registerPlugins'
import { redactToken } from './remoteCommands'
import { RouterError, type BackendRouter } from './router'
import { validateTargetInput } from './targetInput'
import { readTargets, setSshDirect, writeTargets } from './targetStore'
import { scheduleProjectMutation } from './scheduleProjects'
import { TargetManager } from './targets'
import type { BackendEmit, RemoteServerCommand, TargetCredentials } from './types'

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
  const connecting = new Map<string, symbol>()
  registerPluginMethods(router, manager, backendConfig.userData)

  router.register('target.connect', async (params) => {
    const id = requireId(params)
    if (!isRecord(params)) throw new RouterError('invalid_params', '连接参数无效')
    const credentials = readCredentials(params)
    const remember = params.remember === true

    const attempt = Symbol()
    connecting.set(id, attempt)
    let target: Target | undefined
    try {
      target = id === 'local' ? LOCAL_TARGET : (await readTargets(backendConfig.userData)).find((item) => item.id === id)
      if (connecting.get(id) !== attempt) return
    } finally {
      if (connecting.get(id) === attempt) connecting.delete(id)
    }
    if (!target) throw new RouterError('not_found', `目标 ${id} 不存在`)

    const startup = target.kind !== 'local' && params.startup === true
    await manager.connect(target, credentials, remember, startup).catch((err: unknown) => {
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

  router.register('target.forceUpdate', (params) => manager.forceUpdate(requireId(params)))

  router.register('target.enableDirect', async (params) => {
    const id = requireId(params)
    if (!isRecord(params)) throw new RouterError('invalid_params', '参数无效')
    const target = await requireSshTarget(id)
    const credentials = readCredentials(params)
    const listen = optionalString(params.listen, 'listen')?.trim() || DEFAULT_DIRECT_LISTEN
    const dialHost = optionalString(params.host, 'host')?.trim() || target.host
    const enable = ['direct', 'enable', '--listen', listen, ...(params.allowPublic === true ? ['--allow-public'] : [])]
    const grant = ['direct', 'grant', '--name', grantName(), '--host', dialHost]
    const commands: RemoteServerCommand[] = params.reuseListener === true
      ? [['direct', 'status'], (status) => {
        if (status?.enabled === false) return enable
        if (status?.listening === true) return null
        throw new Error(typeof status?.error === 'string' ? status.error : '远端直连监听不可用')
      }, grant]
      : [enable, grant]
    let results: Array<Record<string, unknown>>
    try {
      // 同一 SSH 会话里先开监听再签发授权；之后 SSH 可断开，直连由远端 daemon 常驻提供。
      results = await manager.remoteServer(target, credentials, commands)
    } catch (err) {
      throw connectFailed(err)
    }
    const granted = results.at(-1)
    const code = typeof granted?.code === 'string' ? decodeDirectCode(granted.code) : null
    const grantId = typeof granted?.grantId === 'string' ? granted.grantId : ''
    if (!code || !grantId) throw new RouterError('connect_failed', '远端未返回有效的直连授权')
    const updated = setSshDirect(await readTargets(backendConfig.userData), id, {
      host: dialHost,
      port: code.port,
      fingerprint: code.fingerprint,
      grantId,
    })
    const revoke = (idToRevoke: string) => manager.remoteServer(target, credentials, [['direct', 'revoke', '--id', idToRevoke]])
      .catch(() => undefined)
    if (!updated) {
      void revoke(grantId)
      throw new RouterError('not_found', `目标 ${id} 不存在`)
    }
    try {
      const previousToken = await manager.setDirectToken(id, code.token)
      try {
        await writeTargets(backendConfig.userData, updated.targets)
      } catch (err) {
        await manager.setDirectToken(id, previousToken).catch(() => undefined)
        throw err
      }
    } catch (err) {
      void revoke(grantId)
      throw connectFailed(err)
    }
    manager.updateTarget(updated.target)
    // 新授权落盘后再撤销旧授权，保存失败时旧授权仍可用。
    const previousGrant = target.direct?.grantId
    if (previousGrant && previousGrant !== grantId) void revoke(previousGrant)
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
        // i18n-ignore: 匹配远端返回的错误原文
        if (!message.includes('授权不存在')) throw connectFailed(err)
      }
    }
    // 授权已撤销，凭据存储不可用时仍要清除本地直连配置。
    await manager.setDirectToken(id, undefined).catch(() => undefined)
    const updated = setSshDirect(await readTargets(backendConfig.userData), id, undefined)
    if (!updated) throw new RouterError('not_found', `目标 ${id} 不存在`)
    await writeTargets(backendConfig.userData, updated.targets)
    manager.updateTarget(updated.target)
    return updated.target
  })

  router.register('target.disconnect', (params) => {
    const id = requireId(params)
    connecting.delete(id)
    manager.disconnect(id)
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
    const { targetId, method, params: args } = params
    if (method === 'plugins.rgInstall' || method === 'plugins.rgRemove') {
      throw new RouterError('forbidden', '请在插件管理中安装或移除插件')
    }
    const forward = (value: unknown) => manager.request(targetId, method, value)
    if (method === 'schedule.upsert' || method === 'schedule.runNow' ||
      (method === 'schedule.setEnabled' && isRecord(args) && args.enabled === true)) {
      return scheduleProjectMutation(targetId, method, isRecord(args) ? args : {}, forward)
    }
    return forward(args)
  })

  router.register('codex.send', (params) => {
    if (!isRecord(params) || typeof params.targetId !== 'string' || params.targetId === '') {
      throw new RouterError('invalid_params', 'codex.send 参数无效')
    }
    manager.codexSend(params.targetId, params.msg, params.agent === 'claude' || params.agent === 'pi' ? params.agent : 'codex')
  })
}
