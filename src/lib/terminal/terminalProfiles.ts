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
}

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
  }
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
}

export function getDefaultTerminalProfile(): TerminalProfile {
  const settings = loadTerminalProfileSettings()
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
  return getDefaultTerminalProfile()
}
