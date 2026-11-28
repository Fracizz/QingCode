export const RG_PLUGIN_PLATFORMS = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const
export const MAX_RG_BINARY_BYTES = 8 * 1024 * 1024
export type RgPluginPlatform = (typeof RG_PLUGIN_PLATFORMS)[number]
export type RgPluginInfo = {
  platform: RgPluginPlatform
  version: string
  sha256: string
}
export type RgPluginStatus = {
  platform: RgPluginPlatform | null
  source: 'system' | 'managed' | 'missing'
  version?: string
  installed?: RgPluginInfo
}

export function isRgPluginPlatform(value: unknown): value is RgPluginPlatform {
  return RG_PLUGIN_PLATFORMS.some((platform) => platform === value)
}

export function isRgPluginVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(value)
}

export function parseRgPluginInfo(value: unknown): RgPluginInfo | null {
  if (!value || typeof value !== 'object') return null
  const { platform, version, sha256 } = value as Record<string, unknown>
  if (!isRgPluginPlatform(platform) || !isRgPluginVersion(version) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return null
  return { platform, version, sha256 }
}

export interface PluginMethods {
  'plugins.rgStatus': { params: undefined; result: RgPluginStatus }
  'plugins.rgInstall': { params: { info: RgPluginInfo; binary: string }; result: RgPluginStatus }
  'plugins.rgRemove': { params: undefined; result: RgPluginStatus }
}
