// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { connectionPrewarmAnchors, connectionPrewarmCount, connectionPrewarmProfile, saveConnectionPrewarmProfile } from '../lib/terminal/connectionPrewarmProfile'
import { forgetTerminalProfileTrust, trustTerminalProfile } from '../lib/terminal/terminalProfileTrust'
import { saveTerminalProfileSettings, type TerminalProfile } from '../lib/terminal/terminalProfiles'
import { trustProject } from '../lib/workspaceTrust'
import { connectionPrewarmEnabled, connectionShellPrewarmCount, connectionShellPrewarmCounts, setConnectionPrewarmEnabled } from '../lib/terminal/shellPrewarmSettings'
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
  expect(screen.getByRole('button', { name: '远端 CLI 预热' })).toHaveTextContent('不预热 CLI')
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
  for (const command of ['claude', 'codex', 'opencode', 'pi']) {
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
    expect(connectionPrewarmAnchors(projects)).toEqual([{ cwd: 'ssh://a/tmp/new', profileId: 'ai', command, shell: 'pwsh', count: 1 }])
    expect(connectionPrewarmAnchors(projects, 'a')).toEqual([])
    forgetTerminalProfileTrust(profile.id)
    expect(connectionPrewarmAnchors(projects)).toEqual([])
  }
})

it('does not describe the CLI launch directory', () => {
  const profile: TerminalProfile = { id: 'cc', name: 'CC', shell: 'pwsh', command: 'claude' }
  saveTerminalProfileSettings({ profiles: [profile], defaultProfileId: null, defaultShell: profile.shell })
  trustTerminalProfile(profile)
  saveConnectionPrewarmProfile('c', profile)
  render(<ConnectionPrewarmProfile connectionId="c" />)
  expect(screen.queryByText(/~\/\.qingcode\/cli-prewarm/)).toBeNull()
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

it('sets the prewarmed CLI count per connection and keeps it when switching the CLI', () => {
  const claude: TerminalProfile = { id: 'cc', name: 'CC', shell: 'pwsh', command: 'claude' }
  const codex: TerminalProfile = { id: 'cx', name: 'CX', shell: 'pwsh', command: 'codex' }
  saveTerminalProfileSettings({ profiles: [claude, codex], defaultProfileId: null, defaultShell: 'pwsh' })
  trustTerminalProfile(claude)
  trustTerminalProfile(codex)
  const view = render(<ConnectionPrewarmProfile connectionId="a" />)
  // 未选 CLI 时不显示数量。
  expect(screen.queryByRole('button', { name: '同时预热的 CLI 数量' })).toBeNull()
  act(() => saveConnectionPrewarmProfile('a', claude))
  expect(screen.getByRole('button', { name: '同时预热的 CLI 数量' })).toHaveTextContent('1')
  fireEvent.click(screen.getByRole('button', { name: '同时预热的 CLI 数量' }))
  fireEvent.click(screen.getByRole('option', { name: '3' }))
  expect(connectionPrewarmCount('a')).toBe(3)
  expect(connectionPrewarmCount('b')).toBe(1)
  act(() => saveConnectionPrewarmProfile('a', codex))
  expect(connectionPrewarmCount('a')).toBe(3)
  useProjectStore.setState({ projects: [project('p', 'ssh://a/tmp/p', 1)] })
  trustProject(project('p', 'ssh://a/tmp/p', 1))
  expect(connectionPrewarmAnchors(useProjectStore.getState().projects)).toEqual([
    { cwd: 'ssh://a/tmp/p', profileId: 'cx', command: 'codex', shell: 'pwsh', count: 3 },
  ])
  view.unmount()
})

it('turns prewarming off per connection and hides the CLI choice', () => {
  const profile: TerminalProfile = { id: 'cc', name: 'CC', shell: 'pwsh', command: 'claude' }
  saveTerminalProfileSettings({ profiles: [profile], defaultProfileId: null, defaultShell: profile.shell })
  trustTerminalProfile(profile)
  saveConnectionPrewarmProfile('a', profile)
  const view = render(<ConnectionPrewarmProfile connectionId="a" />)
  expect(screen.getByRole('button', { name: '远端预热' })).toHaveTextContent('开启')
  fireEvent.click(screen.getByRole('button', { name: '远端预热' }))
  fireEvent.click(screen.getByRole('option', { name: '关闭' }))
  expect(connectionPrewarmEnabled('a')).toBe(false)
  expect(screen.queryByRole('button', { name: '远端 CLI 预热' })).toBeNull()
  // 只影响该连接；CLI 选择保留，重新开启后恢复。
  view.rerender(<ConnectionPrewarmProfile connectionId="b" />)
  expect(screen.getByRole('button', { name: '远端 CLI 预热' })).toBeTruthy()
  trustProject(project('p', 'ssh://a/tmp/p', 1))
  expect(connectionPrewarmAnchors([project('p', 'ssh://a/tmp/p', 1)])).toEqual([])
  act(() => setConnectionPrewarmEnabled('a', true))
  expect(connectionPrewarmAnchors([project('p', 'ssh://a/tmp/p', 1)])).toHaveLength(1)
  act(() => setConnectionPrewarmEnabled('a', true))
  view.rerender(<ConnectionPrewarmProfile connectionId="a" />)
  expect(screen.getByRole('button', { name: '远端 CLI 预热' })).toHaveTextContent('CC')
})

it('sets the plain shell count per connection, independent of the CLI pool', () => {
  const view = render(<ConnectionPrewarmProfile connectionId="a" />)
  expect(screen.getByRole('button', { name: '普通 Shell 预热数量' })).toHaveTextContent('自动')
  fireEvent.click(screen.getByRole('button', { name: '普通 Shell 预热数量' }))
  fireEvent.click(screen.getByRole('option', { name: '3' }))
  expect(connectionShellPrewarmCount('a')).toBe(3)
  // 0 只停普通 Shell，CLI 选择仍可用。
  fireEvent.click(screen.getByRole('button', { name: '普通 Shell 预热数量' }))
  fireEvent.click(screen.getByRole('option', { name: '不预热' }))
  expect(connectionShellPrewarmCount('a')).toBe(0)
  expect(screen.getByRole('button', { name: '远端 CLI 预热' })).toBeTruthy()
  view.rerender(<ConnectionPrewarmProfile connectionId="b" />)
  expect(connectionShellPrewarmCount('b')).toBe('auto')
  expect(connectionShellPrewarmCounts()).toEqual({ a: 0 })
  fireEvent.click(screen.getByRole('button', { name: '普通 Shell 预热数量' }))
  fireEvent.click(screen.getByRole('option', { name: '自动（1 个）' }))
  expect(connectionShellPrewarmCounts()).toEqual({ a: 0 })
})
