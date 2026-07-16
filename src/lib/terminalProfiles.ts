export const TERMINAL_PROFILES_KEY = 'qingcode:terminal-profiles'

export interface TerminalProfile {
  id: string
  name: string
  command: string
}

export interface TerminalProfileSettings {
  profiles: TerminalProfile[]
  /** 未指定时使用内置 `DEFAULT_TERMINAL_PROFILE`（普通 PowerShell）。 */
  defaultProfileId: string | null
}

export const DEFAULT_TERMINAL_PROFILE: TerminalProfile = {
  id: 'default',
  name: '普通终端',
  command: '',
}

function normalizeDefaultProfileId(
  id: string | null | undefined,
  profiles: TerminalProfile[]
): string | null {
  if (!id || id === DEFAULT_TERMINAL_PROFILE.id) return null
  return profiles.some(profile => profile.id === id) ? id : null
}

export function getEffectiveDefaultProfileId(settings: TerminalProfileSettings): string {
  return settings.defaultProfileId ?? DEFAULT_TERMINAL_PROFILE.id
}

export function loadTerminalProfileSettings(): TerminalProfileSettings {
  try {
    const value = JSON.parse(localStorage.getItem(TERMINAL_PROFILES_KEY) ?? '{}') as Partial<TerminalProfileSettings>
    const profiles = Array.isArray(value.profiles)
      ? value.profiles.filter(
          (profile): profile is TerminalProfile =>
            Boolean(profile) &&
            typeof profile.id === 'string' &&
            typeof profile.name === 'string' &&
            typeof profile.command === 'string'
        )
      : []
    const allProfiles = profiles.some(profile => profile.id === DEFAULT_TERMINAL_PROFILE.id)
      ? profiles
      : [DEFAULT_TERMINAL_PROFILE, ...profiles]
    const defaultProfileId = normalizeDefaultProfileId(value.defaultProfileId, allProfiles)
    return { profiles: allProfiles, defaultProfileId }
  } catch {
    return { profiles: [DEFAULT_TERMINAL_PROFILE], defaultProfileId: null }
  }
}

export function saveTerminalProfileSettings(settings: TerminalProfileSettings) {
  localStorage.setItem(TERMINAL_PROFILES_KEY, JSON.stringify(settings))
}

export function getDefaultTerminalProfile(): TerminalProfile {
  const settings = loadTerminalProfileSettings()
  if (!settings.defaultProfileId) return DEFAULT_TERMINAL_PROFILE
  return (
    settings.profiles.find(profile => profile.id === settings.defaultProfileId) ??
    DEFAULT_TERMINAL_PROFILE
  )
}

export function getTerminalProfile(profileId?: string): TerminalProfile {
  const settings = loadTerminalProfileSettings()
  if (profileId) {
    const found = settings.profiles.find(profile => profile.id === profileId)
    if (found) return found
  }
  return getDefaultTerminalProfile()
}
