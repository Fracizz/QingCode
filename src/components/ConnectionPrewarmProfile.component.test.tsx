// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { connectionPrewarmAnchors, connectionPrewarmProfile, saveConnectionPrewarmProfile } from '../lib/terminal/connectionPrewarmProfile'
import { forgetTerminalProfileTrust, trustTerminalProfile } from '../lib/terminal/terminalProfileTrust'
import { saveTerminalProfileSettings, type TerminalProfile } from '../lib/terminal/terminalProfiles'
import { trustProject } from '../lib/workspaceTrust'
import type { Project } from '../types'
import { useProjectStore } from '../store/projectStore'
import ConnectionPrewarmProfile from './ConnectionPrewarmProfile'

beforeEach(() => {
  localStorage.clear()
  useProjectStore.setState({ projects: [] })
})

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
  saveConnectionPrewarmProfile('restricted', profile)
  expect(connectionPrewarmProfile('restricted')).toBeUndefined()
  expect(connectionPrewarmAnchors([])).toEqual([])
  const view = render(<ConnectionPrewarmProfile connectionId="restricted" />)
  fireEvent.click(view.getByRole('button', { name: '远端 CLI 预热' }))
  expect(screen.queryByRole('option', { name: 'Script' })).toBeNull()
})

const project = (id: string, path: string, last_opened_at: number, ephemeral = false): Project =>
  ({ id, name: id, path, created_at: 0, last_opened_at, ephemeral })

it('authorizes other connections with their latest trusted project; the active connection uses the current project', () => {
  for (const command of ['claude', 'codex', 'opencode']) {
    localStorage.clear()
    const profile: TerminalProfile = { id: 'ai', name: 'AI', shell: 'pwsh', command }
    saveTerminalProfileSettings({ profiles: [profile], defaultProfileId: null, defaultShell: profile.shell })
    trustTerminalProfile(profile)
    saveConnectionPrewarmProfile('a', profile)
    const projects = [
      project('old', 'ssh://a/tmp/old', 1), project('new', 'ssh://a/tmp/new', 3),
      project('untrusted', 'ssh://a/tmp/untrusted', 9), project('temp', 'ssh://a/tmp/temp', 8, true),
      project('other', 'ssh://b/tmp/other', 5),
    ]
    for (const p of projects) if (p.id !== 'untrusted') trustProject(p)
    expect(connectionPrewarmAnchors(projects)).toEqual([{ cwd: 'ssh://a/tmp/new', profileId: 'ai', command, shell: 'pwsh' }])
    expect(connectionPrewarmAnchors(projects, 'a')).toEqual([])
    forgetTerminalProfileTrust(profile.id)
    expect(connectionPrewarmAnchors(projects)).toEqual([])
  }
})

it('explains that the CLI starts in the dedicated empty directory', () => {
  const profile: TerminalProfile = { id: 'cc', name: 'CC', shell: 'pwsh', command: 'claude' }
  saveTerminalProfileSettings({ profiles: [profile], defaultProfileId: null, defaultShell: profile.shell })
  trustTerminalProfile(profile)
  saveConnectionPrewarmProfile('c', profile)
  render(<ConnectionPrewarmProfile connectionId="c" />)
  expect(screen.getByText(/~\/\.qingcode\/cli-prewarm/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'CLI 启动目录' })).toBeNull()
})

it('hints that prewarming gains less on non-Windows remotes', () => {
  const hint = /Linux\/macOS 远端的 CLI 本身启动较快/
  const project = (id: string, path: string): Project => ({ id, name: id, path, kind: 'ssh', created_at: 1, last_opened_at: 1 })
  useProjectStore.setState({ projects: [project('l', 'ssh://linux/home/dev/app'), project('w', 'ssh://win/C:/Users/dev/app')] })
  const view = render(<ConnectionPrewarmProfile connectionId="linux" />)
  expect(screen.getByText(hint)).toBeTruthy()
  view.rerender(<ConnectionPrewarmProfile connectionId="win" />)
  expect(screen.queryByText(hint)).toBeNull()
  // 没有项目时无法判断远端系统，不提示。
  view.rerender(<ConnectionPrewarmProfile connectionId="none" />)
  expect(screen.queryByText(hint)).toBeNull()
})
