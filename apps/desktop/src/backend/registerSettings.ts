import { backendConfig } from './config'
import { RouterError, type BackendRouter } from './router'
import { mergeAppSettings, sanitizeSettingsPatch } from './settings/appSettings'
import { readAppSettings, writeAppSettings } from './settings/settingsStore'

const APP_NAME = 'QingCode Next'

// T23：应用设置（settings.*）与关于页所需的应用信息（app.info）。
export function registerSettingsMethods(router: BackendRouter): void {
  let pendingSave = Promise.resolve()
  router.register('settings.get', () => readAppSettings(backendConfig.userData))

  router.register('settings.save', async (params) => {
    if (params === undefined || params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw new RouterError('invalid_params', '设置补丁必须是对象')
    }
    const patch = sanitizeSettingsPatch(params)
    // 连续修改多个设置时，每个补丁都要基于上一次已保存的值。
    const saved = pendingSave.then(async () => {
      const current = await readAppSettings(backendConfig.userData)
      const next = mergeAppSettings(current, patch)
      await writeAppSettings(backendConfig.userData, next)
      if (next.general.globalAccessMode !== current.general.globalAccessMode) {
        router.emit('settings.access', { globalAccessMode: next.general.globalAccessMode })
      }
      return next
    })
    pendingSave = saved.then(() => undefined, () => undefined)
    return saved
  })

  router.register('app.info', () => ({ name: APP_NAME, version: backendConfig.appVersion }))
}
