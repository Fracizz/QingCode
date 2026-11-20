// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
const safeInvoke = vi.hoisted(() => vi.fn())
vi.mock('../lib/tauri', async importOriginal => ({ ...await importOriginal<typeof import('../lib/tauri')>(), safeInvoke }))
import { clearCliTrustCache } from '../lib/terminal/cliTrust'
import {
  connectionPrewarmAnchors, connectionPrewarmOptions, connectionPrewarmProfile, preloadConnectionCliTrust, saveConnectionPrewarmProfile,
} from '../lib/terminal/connectionPrewarmProfile'
import { forgetTerminalProfileTrust, trustTerminalProfile } from '../lib/terminal/terminalProfileTrust'
import { saveTerminalProfileSettings, type TerminalProfile } from '../lib/terminal/terminalProfiles'
import { trustProject } from '../lib/workspaceTrust'
import type { Project } from '../types'
import { useProjectStore } from '../store/projectStore'
import ConnectionPrewarmProfile from './ConnectionPrewarmProfile'

beforeEach(() => {
  localStorage.clear()
  clearCliTrustCache()
  safeInvoke.mockReset()
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
const anchor = (cwd: string, command: string) => [{ cwd, profileId: 'ai', command, shell: 'pwsh' }]

function setup(command: string, connection = 'a') {
  const profile: TerminalProfile = { id: 'ai', name: 'AI', shell: 'pwsh', command }
  saveTerminalProfileSettings({ profiles: [profile], defaultProfileId: null, defaultShell: profile.shell })
  trustTerminalProfile(profile)
  saveConnectionPrewarmProfile(connection, profile)
  const projects = [
    project('old', `ssh://${connection}/tmp/old`, 1), project('new', `ssh://${connection}/tmp/new`, 3),
    project('untrusted', `ssh://${connection}/tmp/untrusted`, 9), project('temp', `ssh://${connection}/tmp/temp`, 8, true),
    project('other', 'ssh://b/tmp/other', 5),
  ]
  for (const p of projects) if (p.id !== 'untrusted') trustProject(p)
  return { profile, projects }
}

it('opencode anchors automatically to the latest trusted project unless pinned', () => {
  const { profile, projects } = setup('opencode')
  expect(connectionPrewarmAnchors(projects)).toEqual(anchor('ssh://a/tmp/new', 'opencode'))
  // 自动模式下当前连接交给当前项目
  expect(connectionPrewarmAnchors(projects, 'a')).toEqual([])
  saveConnectionPrewarmProfile('a', profile, { anchor: 'ssh://a/tmp/old' })
  expect(connectionPrewarmAnchors(projects, 'a')).toEqual(anchor('ssh://a/tmp/old', 'opencode'))
  // 固定目录不再受信任或属于其他连接时回到自动
  saveConnectionPrewarmProfile('a', profile, { anchor: 'ssh://a/tmp/untrusted' })
  expect(connectionPrewarmAnchors(projects)).toEqual(anchor('ssh://a/tmp/new', 'opencode'))
  saveConnectionPrewarmProfile('a', profile, { anchor: 'ssh://b/tmp/other' })
  expect(connectionPrewarmAnchors(projects)).toEqual(anchor('ssh://a/tmp/new', 'opencode'))
  forgetTerminalProfileTrust(profile.id)
  expect(connectionPrewarmAnchors(projects)).toEqual([])
})

it('claude and codex never guess: no anchor until the user pins one or allows reading the CLI config', async () => {
  const { profile, projects } = setup('claude')
  expect(connectionPrewarmAnchors(projects)).toEqual([])
  await preloadConnectionCliTrust(projects)
  expect(safeInvoke).not.toHaveBeenCalled()

  saveConnectionPrewarmProfile('a', profile, { readCliConfig: true })
  safeInvoke.mockResolvedValue({ configFound: true, roots: ['ssh://a/tmp/old'] })
  await preloadConnectionCliTrust(projects)
  expect(safeInvoke).toHaveBeenCalledWith('读取 CLI 信任配置', 'ssh_cli_trusted_roots', { connectionId: 'a', agent: 'claude' })
  // CLI 已信任的目录优先于最近打开，即使当前项目就在这条连接上
  expect(connectionPrewarmAnchors(projects, 'a', 'ssh://a/tmp/new')).toEqual(anchor('ssh://a/tmp/old', 'claude'))
  // 结果有缓存，不重复执行远端命令
  await preloadConnectionCliTrust(projects)
  expect(safeInvoke).toHaveBeenCalledTimes(1)

  saveConnectionPrewarmProfile('a', profile, { readCliConfig: true, anchor: 'ssh://a/tmp/new' })
  expect(connectionPrewarmOptions('a')).toEqual({ anchor: 'ssh://a/tmp/new', readCliConfig: true })
  expect(connectionPrewarmAnchors(projects)).toEqual(anchor('ssh://a/tmp/new', 'claude'))
})

it('prefers the current project when the CLI already trusts it', async () => {
  const { profile, projects } = setup('codex')
  saveConnectionPrewarmProfile('a', profile, { readCliConfig: true })
  safeInvoke.mockResolvedValue({ configFound: true, roots: ['ssh://a/tmp/old', 'ssh://a/tmp/new'] })
  await preloadConnectionCliTrust(projects)
  expect(connectionPrewarmAnchors(projects, 'a', 'ssh://a/tmp/old')).toEqual(anchor('ssh://a/tmp/old', 'codex'))
  expect(connectionPrewarmAnchors(projects)).toEqual(anchor('ssh://a/tmp/new', 'codex'))
})

it('lets the user authorize reading, shows trusted projects, and asks to choose when none match', async () => {
  const { projects } = setup('claude', 'c')
  act(() => useProjectStore.setState({ projects }))
  safeInvoke.mockResolvedValue({ configFound: true, roots: [] })
  render(<ConnectionPrewarmProfile connectionId="c" />)
  const select = () => screen.getByRole('button', { name: 'CLI 启动目录' })
  expect(select()).toHaveTextContent('未选择（仅当前项目）')
  expect(screen.getByRole('status')).toHaveTextContent('请手动选择，或开启读取配置自动选择')
  expect(safeInvoke).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('switch', { name: '读取 Claude Code 信任配置自动选择目录' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Claude Code 尚未信任此连接上的任何已信任项目'))
  expect(connectionPrewarmOptions('c').readCliConfig).toBe(true)

  safeInvoke.mockResolvedValue({ configFound: true, roots: ['ssh://c/tmp/old'] })
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
  await waitFor(() => expect(select()).toHaveTextContent('自动 · /tmp/old'))
  fireEvent.click(select())
  expect(screen.getByRole('option', { name: '/tmp/old · Claude Code 已信任' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('option', { name: '/tmp/new' }))
  expect(connectionPrewarmOptions('c')).toEqual({ anchor: 'ssh://c/tmp/new', readCliConfig: true })
  expect(screen.getByRole('status')).toHaveTextContent('所选目录未在 Claude Code 中信任')
})

it('reports a missing CLI config and read failures', async () => {
  const { profile, projects } = setup('codex', 'd')
  saveConnectionPrewarmProfile('d', profile, { readCliConfig: true })
  act(() => useProjectStore.setState({ projects }))
  safeInvoke.mockResolvedValue({ configFound: false, roots: [] })
  const view = render(<ConnectionPrewarmProfile connectionId="d" />)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('远端没有 Codex 配置文件'))
  view.unmount()
  safeInvoke.mockRejectedValue(new Error('连接已断开'))
  render(<ConnectionPrewarmProfile connectionId="d" />)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('读取 Codex 配置失败：连接已断开'))
})
