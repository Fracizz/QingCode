export const TERMINAL_PROFILES_KEY = 'qingcode:terminal-profiles'

export interface TerminalProfile {
  id: string
  name: string
  command: string
}

export interface TerminalProfileSettings {
  profiles: TerminalProfile[]
  defaultProfileId: string
}

export const DEFAULT_TERMINAL_PROFILE: TerminalProfile = {
  id: 'default',
  name: '普通终端',
  command: '',
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
    const defaultProfileId = allProfiles.some(profile => profile.id === value.defaultProfileId)
      ? value.defaultProfileId!
      : DEFAULT_TERMINAL_PROFILE.id
    return { profiles: allProfiles, defaultProfileId }
  } catch {
    return { profiles: [DEFAULT_TERMINAL_PROFILE], defaultProfileId: DEFAULT_TERMINAL_PROFILE.id }
  }
}

export function saveTerminalProfileSettings(settings: TerminalProfileSettings) {
  localStorage.setItem(TERMINAL_PROFILES_KEY, JSON.stringify(settings))
}

export function getDefaultTerminalProfile(): TerminalProfile {
  const settings = loadTerminalProfileSettings()
  return (
    settings.profiles.find(profile => profile.id === settings.defaultProfileId) ??
    DEFAULT_TERMINAL_PROFILE
  )
}
