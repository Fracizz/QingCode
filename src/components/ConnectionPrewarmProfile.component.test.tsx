// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { connectionPrewarmAnchors, connectionPrewarmProfile, saveConnectionPrewarmProfile } from '../lib/terminal/connectionPrewarmProfile'
import { forgetTerminalProfileTrust, trustTerminalProfile } from '../lib/terminal/terminalProfileTrust'
import { saveTerminalProfileSettings, type TerminalProfile } from '../lib/terminal/terminalProfiles'
import ConnectionPrewarmProfile from './ConnectionPrewarmProfile'

it('opts in per connection and binds background execution to the trusted command and shell', () => {
  const profile: TerminalProfile = { id: 'agent', name: 'Claude', shell: 'pwsh', command: 'claude' }
  const settings = { profiles: [profile], defaultProfileId: null, defaultShell: profile.shell }
  saveTerminalProfileSettings(settings)
  const view = render(<ConnectionPrewarmProfile connectionId="a" />)
  fireEvent.click(screen.getByRole('button', { name: '远端 CLI 预热' }))
  expect(screen.getByRole('option', { name: 'Claude' })).toBeDisabled()
  act(() => trustTerminalProfile(profile))
  fireEvent.click(screen.getByRole('option', { name: 'Claude' }))
  expect(connectionPrewarmProfile('a')).toEqual(profile)
  view.rerender(<ConnectionPrewarmProfile connectionId="b" />)
  expect(screen.getByRole('button', { name: '远端 CLI 预热' })).toHaveTextContent('仅预热普通 Shell')
  expect(connectionPrewarmProfile('b')).toBeUndefined()
  act(() => saveTerminalProfileSettings({ ...settings, profiles: [{ ...profile, command: 'claude --resume' }] }))
  expect(connectionPrewarmProfile('a')).toBeUndefined()
  act(() => saveTerminalProfileSettings({ ...settings, profiles: [{ ...profile, shell: 'bash' }] }))
  expect(connectionPrewarmProfile('a')).toBeUndefined()
  act(() => saveTerminalProfileSettings(settings))
  act(() => forgetTerminalProfileTrust(profile.id))
  expect(connectionPrewarmProfile('a')).toBeUndefined()
})

it('excludes arbitrary commands even if the profile has already been trusted', () => {
  const profile: TerminalProfile = { id: 'script', name: 'Script', shell: 'pwsh', command: 'build.ps1' }
  saveTerminalProfileSettings({ profiles: [profile], defaultProfileId: null, defaultShell: profile.shell })
  trustTerminalProfile(profile)
  saveConnectionPrewarmProfile('restricted', profile, 'ssh://restricted/tmp/project')
  expect(connectionPrewarmProfile('restricted')).toBeUndefined()
  expect(connectionPrewarmAnchors()).toEqual([])
  const view = render(<ConnectionPrewarmProfile connectionId="restricted" />)
  fireEvent.click(view.getByRole('button', { name: '远端 CLI 预热' }))
  expect(screen.queryByRole('option', { name: 'Script' })).toBeNull()
})

it('only sends an anchor belonging to the selected trusted profile and connection', () => {
  const profile: TerminalProfile = { id: 'ai', name: 'AI', shell: 'pwsh', command: 'codex' }
  const settings = { profiles: [profile], defaultProfileId: null, defaultShell: profile.shell }
  saveTerminalProfileSettings(settings)
  trustTerminalProfile(profile)
  saveConnectionPrewarmProfile('a', profile, 'ssh://b/tmp/wrong')
  expect(connectionPrewarmAnchors()).toEqual([])
  saveConnectionPrewarmProfile('a', profile, 'ssh://a/tmp/anchor')
  expect(connectionPrewarmAnchors()).toEqual([{ cwd: 'ssh://a/tmp/anchor', profileId: 'ai', command: 'codex', shell: 'pwsh' }])
  forgetTerminalProfileTrust(profile.id)
  expect(connectionPrewarmAnchors()).toEqual([])
})
