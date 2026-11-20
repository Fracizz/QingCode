// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { localCodexPrewarm, saveLocalCodexPrewarm, supportsCodexPrewarm } from './localCodexPrewarm'
import { forgetTerminalProfileTrust, trustTerminalProfile } from './terminalProfileTrust'
import { saveTerminalProfileSettings, type TerminalProfile } from './terminalProfiles'

const profile: TerminalProfile = { id: 'ai', name: 'Codex', command: 'codex', shell: 'pwsh' }
function persist(p: TerminalProfile) {
  saveTerminalProfileSettings({ profiles: [p], defaultProfileId: null, defaultShell: 'pwsh' })
}

beforeEach(() => localStorage.clear())

it('binds opt-in to the trusted profile, shell and command', () => {
  persist(profile)
  saveLocalCodexPrewarm(profile)
  expect(localCodexPrewarm()).toBeUndefined()
  trustTerminalProfile(profile)
  expect(localCodexPrewarm()).toEqual(profile)
  persist({ ...profile, shell: 'bash' })
  expect(localCodexPrewarm()).toBeUndefined()
  persist(profile)
  forgetTerminalProfileTrust(profile.id)
  expect(localCodexPrewarm()).toBeUndefined()
})

it('preserves an older profile selection and discards its saved project directory', () => {
  persist(profile)
  trustTerminalProfile(profile)
  localStorage.setItem('qingcode:local-codex-prewarm', JSON.stringify({
    cwd: 'D:/former-project', profileId: profile.id, shell: profile.shell, command: profile.command,
  }))
  expect(localCodexPrewarm()).toEqual(profile)
})

it('only prestarts fresh CLI sessions', () => {
  for (const command of ['codex', 'claude', 'opencode']) {
    expect(supportsCodexPrewarm({ ...profile, command })).toBe(true)
  }
  for (const command of ['codex resume', 'codex; whoami', 'echo codex', 'claude --continue', 'opencode attach', 'opencode; whoami']) {
    expect(supportsCodexPrewarm({ ...profile, command })).toBe(false)
  }
  expect(supportsCodexPrewarm({ ...profile, shell: 'cmd' })).toBe(false)
})
