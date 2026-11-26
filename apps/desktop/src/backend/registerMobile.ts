import { backendConfig } from './config'
import { MobileService } from './mobile/service'
import { RouterError, type BackendRouter } from './router'
import { defaultSecretCipher } from './secretStore'

let service: MobileService | null = null
let startup: Promise<void> = Promise.resolve()

// T9：手机网关（mobile.* 设置/设备/连接信息，HTTPS 网关生命周期）。
export function registerMobileMethods(router: BackendRouter): void {
  const previous = service
  const ready = startup.then(async () => {
    if (previous) await previous.dispose().catch(() => undefined)
  })
  const current = new MobileService({
    userData: backendConfig.userData,
    router,
    cipher: defaultSecretCipher(),
    version: backendConfig.appVersion,
  })
  service = current

  router.register('mobile.getSettings', () => current.getSettings())
  router.register('mobile.saveSettings', (params) => current.saveSettings(params ?? {}))
  router.register('mobile.connectionInfo', (params) => {
    const address = typeof params?.address === 'string' ? params.address.trim() : ''
    if (!address) throw new RouterError('invalid_params', '请选择连接地址')
    return current.connectionInfo({ address })
  })
  router.register('mobile.devices', () => current.devices())
  router.register('mobile.revokeDevice', (params) => {
    const id = typeof params?.id === 'string' ? params.id.trim() : ''
    if (!id) throw new RouterError('invalid_params', '设备 id 无效')
    return current.revokeDevice({ id })
  })
  router.register('mobile.regenerateCert', () => current.regenerateCert())

  startup = ready.then(() => current.start()).catch(() => undefined)
  void startup
}
