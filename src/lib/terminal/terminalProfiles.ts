import { notifyShellPrewarmChanged } from './shellPrewarmSettings'
import {
  defaultTerminalShell,
  normalizeTerminalShell,
  type TerminalShellId,
} from '@/lib/terminal/terminalShell'

export const TERMINAL_PROFILES_KEY = 'qingcode:terminal-profiles'

export interface TerminalProfile {
  id: string
  name: string
  command: string
  /** Host shell preference (auto / powershell / pwsh / cmd / wsl / bash / zsh). */
  shell: TerminalShellId
  /**
   * 归属分类：缺省为「通用」（所有连接可见）；`LOCAL_PROFILE_SCOPE` 为本机；其他值为 SSH 连接 id。
   * 新建终端菜单、手机端与连接默认配置只列出目标项目所属分类和通用配置。
   */
  scope?: string
}

/** 本机（Windows / WSL 等非 SSH 项目）分类。 */
export const LOCAL_PROFILE_SCOPE = 'local'

export interface TerminalProfileSettings {
  profiles: TerminalProfile[]
  /** 未指定时使用内置 `DEFAULT_TERMINAL_PROFILE`。 */
  defaultProfileId: string | null
  /**
   * Global default host shell (settings → 终端).
   * Used by the built-in「普通终端」and as the initial shell for new profiles.
   */
  defaultShell: TerminalShellId
}

export const DEFAULT_TERMINAL_PROFILE: TerminalProfile = {
  id: 'default',
  name: '普通终端',
  command: '',
  shell: defaultTerminalShell(),
}

function normalizeProfile(raw: unknown): TerminalProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const profile = raw as Partial<TerminalProfile>
  if (
    typeof profile.id !== 'string' ||
    typeof profile.name !== 'string' ||
    typeof profile.command !== 'string'
  ) {
    return null
  }
  return {
    id: profile.id,
    name: profile.name,
    command: profile.command,
    shell: normalizeTerminalShell(profile.shell),
    ...(typeof profile.scope === 'string' && profile.scope.trim() && { scope: profile.scope.trim() }),
  }
}

/** 项目所属分类：SSH 项目为连接 id，其余为本机。 */
export function profileScopeFor(connectionId: string | null | undefined): string {
  return connectionId || LOCAL_PROFILE_SCOPE
}

/** 内置普通终端和通用配置对所有连接可见；分类配置只对自己的连接（或本机）可见。 */
export function isProfileVisibleFor(
  profile: Pick<TerminalProfile, 'id' | 'scope'>,
  connectionId: string | null | undefined,
): boolean {
  return profile.id === DEFAULT_TERMINAL_PROFILE.id || !profile.scope || profile.scope === profileScopeFor(connectionId)
}

/** 复制到指定分类（`undefined` 为通用），生成新 id；信任按 id 记录，副本首次运行仍需确认。 */
export function copyProfileToScope(
  source: Pick<TerminalProfile, 'name' | 'command' | 'shell'>,
  scope: string | undefined,
  name = source.name,
): TerminalProfile {
  return { id: crypto.randomUUID(), name, command: source.command, shell: source.shell, ...(scope && { scope }) }
}

export function profilesForConnection(
  settings: TerminalProfileSettings,
  connectionId: string | null | undefined,
): TerminalProfile[] {
  return settings.profiles.filter(profile => isProfileVisibleFor(profile, connectionId))
}

function normalizeDefaultProfileId(
  id: string | null | undefined,
  profiles: TerminalProfile[],
): string | null {
  if (!id || id === DEFAULT_TERMINAL_PROFILE.id) return null
  return profiles.some(profile => profile.id === id) ? id : null
}

export function getEffectiveDefaultProfileId(settings: TerminalProfileSettings): string {
  return settings.defaultProfileId ?? DEFAULT_TERMINAL_PROFILE.id
}

export function loadTerminalProfileSettings(): TerminalProfileSettings {
  try {
    const value = JSON.parse(
      localStorage.getItem(TERMINAL_PROFILES_KEY) ?? '{}',
    ) as Partial<TerminalProfileSettings>
    const defaultShell = normalizeTerminalShell(value.defaultShell)
    const profiles = Array.isArray(value.profiles)
      ? value.profiles.map(normalizeProfile).filter((p): p is TerminalProfile => p !== null)
      : []
    const withDefault = profiles.some(profile => profile.id === DEFAULT_TERMINAL_PROFILE.id)
      ? profiles.map(profile =>
          profile.id === DEFAULT_TERMINAL_PROFILE.id
            ? {
                ...DEFAULT_TERMINAL_PROFILE,
                ...profile,
                // Built-in profile always follows the global default shell.
                shell: defaultShell,
              }
            : profile,
        )
      : [{ ...DEFAULT_TERMINAL_PROFILE, shell: defaultShell }, ...profiles]
    const defaultProfileId = normalizeDefaultProfileId(value.defaultProfileId, withDefault)
    return { profiles: withDefault, defaultProfileId, defaultShell }
  } catch {
    const defaultShell = defaultTerminalShell()
    return {
      profiles: [{ ...DEFAULT_TERMINAL_PROFILE, shell: defaultShell }],
      defaultProfileId: null,
      defaultShell,
    }
  }
}

export function saveTerminalProfileSettings(settings: TerminalProfileSettings) {
  const defaultShell = normalizeTerminalShell(settings.defaultShell)
  const profiles = settings.profiles.map(profile =>
    profile.id === DEFAULT_TERMINAL_PROFILE.id
      ? { ...profile, shell: defaultShell }
      : profile,
  )
  localStorage.setItem(
    TERMINAL_PROFILES_KEY,
    JSON.stringify({
      ...settings,
      defaultShell,
      profiles,
    }),
  )
  notifyShellPrewarmChanged()
}

export function getDefaultTerminalProfile(settings = loadTerminalProfileSettings()): TerminalProfile {
  const base =
    settings.profiles.find(profile => profile.id === settings.defaultProfileId) ??
    settings.profiles.find(profile => profile.id === DEFAULT_TERMINAL_PROFILE.id) ??
    DEFAULT_TERMINAL_PROFILE
  if (base.id === DEFAULT_TERMINAL_PROFILE.id || !settings.defaultProfileId) {
    // Built-in ordinary terminal → always use global default shell.
    const builtin =
      settings.profiles.find(p => p.id === DEFAULT_TERMINAL_PROFILE.id) ?? DEFAULT_TERMINAL_PROFILE
    return { ...builtin, shell: settings.defaultShell }
  }
  return base
}

/** 不能领取的默认配置仍为普通终端预热。 */
export function getPrewarmShell(): TerminalShellId {
  const settings = loadTerminalProfileSettings()
  const candidate = getDefaultTerminalProfile(settings)
  // 全局默认归属其他连接时，本机新建终端用普通终端。
  const profile = isProfileVisibleFor(candidate, null) ? candidate : { ...DEFAULT_TERMINAL_PROFILE, shell: settings.defaultShell }
  return profile.shell === 'wsl' || (profile.shell === 'cmd' && profile.command.trim())
    ? settings.defaultShell : profile.shell
}

export function getTerminalProfile(profileId?: string): TerminalProfile {
  const settings = loadTerminalProfileSettings()
  if (profileId) {
    const found = settings.profiles.find(profile => profile.id === profileId)
    if (found) {
      if (found.id === DEFAULT_TERMINAL_PROFILE.id) {
        return { ...found, shell: settings.defaultShell }
      }
      return found
    }
  }
  return getDefaultTerminalProfile(settings)
}
