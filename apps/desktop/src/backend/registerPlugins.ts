import { extname, isAbsolute } from 'node:path'
import { isRgPluginPlatform, parseRgPluginInfo, type RgPluginStatus } from '@qn/protocol'
import { PluginPackages } from './pluginPackages'
import { RouterError, type BackendRouter } from './router'
import type { TargetManager } from './targets'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object'
  ? value as Record<string, unknown>
  : {}

function targetId(params: unknown): string {
  const { id } = record(params)
  if (typeof id !== 'string' || !id) throw new RouterError('invalid_params', '目标 id 无效')
  return id
}

export function registerPluginMethods(router: BackendRouter, manager: TargetManager, userData: string): void {
  const packages = new PluginPackages(userData)
  router.register('plugins.list', () => packages.list())
  router.register('plugins.import', (params) => {
    const { path } = record(params)
    if (typeof path !== 'string' || !isAbsolute(path) || extname(path).toLowerCase() !== '.qnplugin') {
      throw new RouterError('invalid_params', '请选择 .qnplugin 文件')
    }
    return packages.import(path)
  })
  router.register('plugins.forget', (params) => {
    const { platform } = record(params)
    if (!isRgPluginPlatform(platform)) throw new RouterError('invalid_params', '插件包格式无效')
    return packages.remove(platform)
  })
  router.register('plugins.status', async (params) => {
    try {
      return await manager.request(targetId(params), 'plugins.rgStatus') as RgPluginStatus
    } catch (error) {
      if (error instanceof RouterError && error.code === 'method') {
        throw new RouterError('method', '请先更新目标 Server 再管理插件')
      }
      throw error
    }
  })
  router.register('plugins.install', async (params) => {
    const id = targetId(params)
    const requested = parseRgPluginInfo(record(params).info)
    if (!requested) throw new RouterError('invalid_params', '插件包格式无效')
    const pack = await packages.read(requested.platform)
    if (pack.info.sha256 !== requested.sha256 || pack.info.platform !== requested.platform || pack.info.version !== requested.version) {
      throw new RouterError('conflict', '离线插件包已更改，请刷新后再安装')
    }
    return await manager.manageRg(id, 'plugins.rgInstall', pack) as RgPluginStatus
  })
  router.register('plugins.remove', async (params) =>
    await manager.manageRg(targetId(params), 'plugins.rgRemove') as RgPluginStatus)
}
