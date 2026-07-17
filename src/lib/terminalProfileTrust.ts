import type { TerminalProfile } from './terminalProfiles'
import { confirmDialog } from '../store/confirmStore'
import { translate } from './i18n'

export const TERMINAL_PROFILE_TRUST_KEY = 'qingcode:terminal-profile-trust'
export const TERMINAL_PROFILE_TRUST_CHANGED_EVENT = 'qingcode:terminal-profile-trust-changed'

type TrustEntry = {
  profileId: string
  /** Normalized command snapshot; changing the command invalidates trust. */
  command: string
}

type TrustStore = {
  entries: TrustEntry[]
}

function emptyStore(): TrustStore {
  return { entries: [] }
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function readStore(): TrustStore {
  try {
    const raw = localStorage.getItem(TERMINAL_PROFILE_TRUST_KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw) as Partial<TrustStore>
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter(
          (entry): entry is TrustEntry =>
            Boolean(entry) &&
            typeof entry.profileId === 'string' &&
            typeof entry.command === 'string',
        )
      : []
    return { entries }
  } catch {
    return emptyStore()
  }
}

function writeStore(store: TrustStore) {
  try {
    localStorage.setItem(TERMINAL_PROFILE_TRUST_KEY, JSON.stringify(store))
  } catch {
    // Quota / private mode — trust will not persist.
  }
  window.dispatchEvent(new Event(TERMINAL_PROFILE_TRUST_CHANGED_EVENT))
}

export function isTerminalProfileTrusted(profile: Pick<TerminalProfile, 'id' | 'command'>): boolean {
  const command = normalizeCommand(profile.command)
  if (!command) return true
  return readStore().entries.some(
    entry => entry.profileId === profile.id && entry.command === command,
  )
}

export function trustTerminalProfile(profile: Pick<TerminalProfile, 'id' | 'command'>): void {
  const command = normalizeCommand(profile.command)
  if (!command) return
  const store = readStore()
  const next = store.entries.filter(entry => entry.profileId !== profile.id)
  next.push({ profileId: profile.id, command })
  writeStore({ entries: next })
}

export function untrustTerminalProfile(profileId: string): void {
  const store = readStore()
  const next = store.entries.filter(entry => entry.profileId !== profileId)
  if (next.length === store.entries.length) return
  writeStore({ entries: next })
}

/**
 * First-run confirmation before executing a custom terminal profile command.
 * Empty commands (built-in PowerShell) need no trust. Mirrors `.qingcode/run.json` trust UX.
 */
export async function ensureTerminalProfileTrust(
  profile: Pick<TerminalProfile, 'id' | 'name' | 'command'>,
): Promise<boolean> {
  const command = normalizeCommand(profile.command)
  if (!command) return true
  if (isTerminalProfileTrusted(profile)) return true

  const choice = await confirmDialog({
    title: translate('运行终端配置命令'),
    message: translate(
      '即将执行终端配置中的自定义启动命令。请确认命令内容后再继续。',
    ),
    detail: [
      translate('配置：{name}', { name: profile.name.trim() || translate('未命名配置') }),
      translate('命令：{command}', { command }),
    ].join('\n'),
    kind: 'warning',
    confirmLabel: translate('确认一次'),
    altLabel: translate('信任此配置'),
    cancelLabel: translate('取消'),
  })
  if (choice === false) return false
  if (choice === 'alt') trustTerminalProfile(profile)
  return true
}
