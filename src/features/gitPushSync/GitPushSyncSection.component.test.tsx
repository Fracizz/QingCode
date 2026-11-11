// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/store/projectStore'
import type { Project } from '@/types'
import { DEFAULT_CONFIG } from './core'
import GitPushSyncSection from './GitPushSyncSection'
import { resetScanCache } from './scanCache'
import { useGitPushSyncStore } from './store'

const mocks = vi.hoisted(() => ({
  saveConfig: vi.fn(),
  getGitRemotes: vi.fn(),
  getGitHead: vi.fn(),
  getPushSyncTracking: vi.fn(),
  listSshConnections: vi.fn(),
  isProjectTrusted: vi.fn(),
}))

vi.mock('./runtime', () => ({ saveConfig: mocks.saveConfig }))
vi.mock('@/lib/ipc/git', () => ({
  getGitRemotes: mocks.getGitRemotes,
  getGitHead: mocks.getGitHead,
}))
vi.mock('@/lib/ipc/gitPushSync', () => ({ getPushSyncTracking: mocks.getPushSyncTracking }))
vi.mock('@/lib/projectRepository', () => ({ listSshConnections: mocks.listSshConnections }))
vi.mock('@/lib/workspaceTrust', () => ({ isProjectTrusted: mocks.isProjectTrusted }))

const local = { id: 'a', name: 'app-local', path: 'C:/a', kind: 'local' } as Project
const remote = {
  id: 'b',
  name: 'app-server',
  path: 'ssh://c/b',
  kind: 'ssh',
  connection_id: 'c',
} as Project
const offline = { id: 'x', name: 'app-offline', path: 'ssh://d/x', kind: 'ssh' } as Project

describe('GitPushSyncSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetScanCache()
    mocks.saveConfig.mockImplementation(async config =>
      useGitPushSyncStore.getState().setConfig(config),
    )
    mocks.listSshConnections.mockResolvedValue([{ id: 'c', name: '服务器 B' }])
    mocks.isProjectTrusted.mockReturnValue(true)
    mocks.getGitRemotes.mockImplementation(async (path: string) => {
      if (path === offline.path) throw new Error('未连接')
      return [{ name: 'origin', fetch_url: 'git@gitee.com:team/app.git', push_urls: [] }]
    })
    mocks.getGitHead.mockResolvedValue({ name: 'test', detached: false })
    mocks.getPushSyncTracking.mockResolvedValue({ branch: 'test', upstream: null, ahead: 0, behind: 0 })
    useProjectStore.setState({ projects: [local, remote, offline] })
    useGitPushSyncStore.setState({ config: DEFAULT_CONFIG, detection: {}, results: {} })
  })

  it('does not touch Git while disabled', () => {
    render(<GitPushSyncSection />)
    expect(screen.queryByText('app-local')).toBeNull()
    expect(mocks.getGitRemotes).not.toHaveBeenCalled()
  })

  it('persists the master switch', () => {
    render(<GitPushSyncSection />)
    fireEvent.change(screen.getByLabelText('启用推送后自动同步'), { target: { value: 'on' } })
    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
  })

  it('groups projects by repository and separates unreachable ones', async () => {
    useGitPushSyncStore.setState({
      config: { ...DEFAULT_CONFIG, enabled: true },
      detection: { 'ssh://c/b': { state: 'live', detail: null } },
    })
    render(<GitPushSyncSection />)
    await screen.findByText('gitee.com/team/app')
    await screen.findByText('服务器 B')
    expect(screen.getByText('未连接或没有远程仓库')).toBeTruthy()
    expect(screen.getByText('实时')).toBeTruthy()
  })

  it('reads SSH branches with the lightweight tracking query instead of a full status', async () => {
    useGitPushSyncStore.setState({ config: { ...DEFAULT_CONFIG, enabled: true } })
    render(<GitPushSyncSection />)
    await screen.findByText('gitee.com/team/app')
    expect(mocks.getPushSyncTracking).toHaveBeenCalledWith(remote.path)
    expect(mocks.getGitHead).not.toHaveBeenCalledWith(remote.path)
    expect(mocks.getGitHead).toHaveBeenCalledWith(local.path)
  })

  it('toggles a project as receiver', async () => {
    useGitPushSyncStore.setState({ config: { ...DEFAULT_CONFIG, enabled: true } })
    render(<GitPushSyncSection />)
    await screen.findByText('gitee.com/team/app')
    fireEvent.click(screen.getByLabelText('自动接收 app-server'))
    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ receivers: ['b'] }))
  })

  it('does not allow untrusted projects to receive updates', async () => {
    mocks.isProjectTrusted.mockReturnValue(false)
    useGitPushSyncStore.setState({ config: { ...DEFAULT_CONFIG, enabled: true } })
    render(<GitPushSyncSection />)
    const checkbox = (await screen.findByLabelText('自动接收 app-server')) as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
  })

  it('shows a loading state instead of the table until every project has been inspected', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    mocks.getGitRemotes.mockImplementation(async (path: string) => {
      if (path === offline.path) {
        await gate
        throw new Error('未连接')
      }
      return [{ name: 'origin', fetch_url: 'git@gitee.com:team/app.git', push_urls: [] }]
    })
    useGitPushSyncStore.setState({ config: { ...DEFAULT_CONFIG, enabled: true } })
    render(<GitPushSyncSection />)
    await waitFor(() => expect(mocks.getGitRemotes).toHaveBeenCalledTimes(3))
    // 不同机器并行读取；最后一个完成前不渲染表格，也就无从点击、不会跳动。
    await screen.findByText('正在识别仓库 2/3')
    expect(screen.queryByLabelText('自动接收 app-local')).toBeNull()
    expect(screen.queryByText('gitee.com/team/app')).toBeNull()
    release()
    await screen.findByText('gitee.com/team/app')
    expect(screen.queryByText('读取完成后即可设置自动接收')).toBeNull()
  })

  it('keeps the cached group when a refresh cannot reach the project', async () => {
    useGitPushSyncStore.setState({ config: { ...DEFAULT_CONFIG, enabled: true } })
    useProjectStore.setState({ projects: [local, remote] })
    const first = render(<GitPushSyncSection />)
    await screen.findByText('gitee.com/team/app')
    first.unmount()
    mocks.getGitRemotes.mockRejectedValue(new Error('未连接'))
    render(<GitPushSyncSection />)
    await waitFor(() => expect(screen.queryByText(/正在刷新/)).toBeNull())
    expect(screen.getByText('gitee.com/team/app')).toBeTruthy()
    expect(screen.queryByText('未连接或没有远程仓库')).toBeNull()
  })

  it('reuses the last grouping when the section is reopened', async () => {
    useGitPushSyncStore.setState({ config: { ...DEFAULT_CONFIG, enabled: true } })
    const first = render(<GitPushSyncSection />)
    await screen.findByText('gitee.com/team/app')
    first.unmount()
    render(<GitPushSyncSection />)
    expect(screen.getByText('gitee.com/team/app')).toBeTruthy()
    expect(screen.queryByText('读取完成后即可设置自动接收')).toBeNull()
  })
})
