import { getEffectiveDefaultProfileId, loadTerminalProfileSettings, type TerminalProfileSettings } from './terminalProfiles'

export const CONNECTION_DEFAULT_PROFILE_PREFIX = 'qingcode:connection-default-profile:'
export const CONNECTION_DEFAULT_PROFILE_CHANGED_EVENT = 'qingcode:connection-default-profile-changed'

/** 远程连接自己的新建终端默认配置；null 表示跟随全局默认。 */
export function saveConnectionDefaultProfileId(connectionId: string, profileId: string | null) {
  const key = CONNECTION_DEFAULT_PROFILE_PREFIX + connectionId
  try {
    if (profileId) localStorage.setItem(key, profileId)
    else localStorage.removeItem(key)
  } catch {
    // 存储不可用时保持跟随全局默认。
  }
  window.dispatchEvent(new Event(CONNECTION_DEFAULT_PROFILE_CHANGED_EVENT))
}

/** 已删除的配置自动失效，回落到全局默认。 */
export function connectionDefaultProfileId(
  connectionId: string | null | undefined,
  settings: TerminalProfileSettings = loadTerminalProfileSettings(),
): string | null {
  if (!connectionId) return null
  try {
    const id = localStorage.getItem(CONNECTION_DEFAULT_PROFILE_PREFIX + connectionId)
    return id && settings.profiles.some(profile => profile.id === id) ? id : null
  } catch {
    return null
  }
}

/** 新建终端实际使用的默认配置：连接设置优先，其次全局默认。 */
export function effectiveDefaultProfileIdFor(
  connectionId: string | null | undefined,
  settings: TerminalProfileSettings = loadTerminalProfileSettings(),
): string {
  return connectionDefaultProfileId(connectionId, settings) ?? getEffectiveDefaultProfileId(settings)
}
