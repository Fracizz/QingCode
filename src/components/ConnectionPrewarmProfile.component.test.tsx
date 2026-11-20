// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { connectionPrewarmProfile } from '../lib/terminal/connectionPrewarmProfile'
import { forgetTerminalProfileTrust, trustTerminalProfile } from '../lib/terminal/terminalProfileTrust'
import { saveTerminalProfileSettings, type TerminalProfile } from '../lib/terminal/terminalProfiles'
import ConnectionPrewarmProfile from './ConnectionPrewarmProfile'

it('opts in per connection and binds background execution to the trusted command and shell', () => {
  const profile: TerminalProfile = { id: 'agent', name: 'Claude', shell: 'pwsh', command: 'claude' }
  const settings = { profiles: [profile], defaultProfileId: null, defaultShell: profile.shell }
  saveTerminalProfileSettings(settings)
  const view = render(<ConnectionPrewarmProfile connectionId="a" />)
  fireEvent.click(screen.getByRole('button', { name: '预热终端配置' }))
  expect(screen.getByRole('option', { name: 'Claude' })).toBeDisabled()
  act(() => trustTerminalProfile(profile))
  fireEvent.click(screen.getByRole('option', { name: 'Claude' }))
  expect(connectionPrewarmProfile('a')).toEqual(profile)
  view.rerender(<ConnectionPrewarmProfile connectionId="b" />)
  expect(screen.getByRole('button', { name: '预热终端配置' })).toHaveTextContent('仅预热普通 Shell')
  expect(connectionPrewarmProfile('b')).toBeUndefined()
  act(() => saveTerminalProfileSettings({ ...settings, profiles: [{ ...profile, command: 'claude --resume' }] }))
  expect(connectionPrewarmProfile('a')).toBeUndefined()
  act(() => saveTerminalProfileSettings({ ...settings, profiles: [{ ...profile, shell: 'bash' }] }))
  expect(connectionPrewarmProfile('a')).toBeUndefined()
  act(() => saveTerminalProfileSettings(settings))
  act(() => forgetTerminalProfileTrust(profile.id))
  expect(connectionPrewarmProfile('a')).toBeUndefined()
})
