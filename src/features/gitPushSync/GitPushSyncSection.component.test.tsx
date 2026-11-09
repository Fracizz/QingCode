// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/store/projectStore'
import type { Project } from '@/types'
import { DEFAULT_CONFIG } from './core'
import GitPushSyncSection from './GitPushSyncSection'
import { useGitPushSyncStore } from './store'

const mocks = vi.hoisted(() => ({
  saveConfig: vi.fn(),
  getGitRemotes: vi.fn(),
  getGitStatus: vi.fn(),
  listSshConnections: vi.fn(),
  isProjectTrusted: vi.fn(),
}))

vi.mock('./runtime', () => ({ saveConfig: mocks.saveConfig }))
vi.mock('@/lib/ipc/git', () => ({
  getGitRemotes: mocks.getGitRemotes,
  getGitStatus: mocks.getGitStatus,
}))
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
    mocks.saveConfig.mockImplementation(async config =>
      useGitPushSyncStore.getState().setConfig(config),
    )
    mocks.listSshConnections.mockResolvedValue([{ id: 'c', name: '服务器 B' }])
    mocks.isProjectTrusted.mockReturnValue(true)
    mocks.getGitRemotes.mockImplementation(async (path: string) => {
      if (path === offline.path) throw new Error('未连接')
      return [{ name: 'origin', fetch_url: 'git@gitee.com:team/app.git', push_urls: [] }]
    })
    mocks.getGitStatus.mockResolvedValue({ is_repository: true, branch: 'test', changes: [] })
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

  it('toggles a project as receiver', async () => {
    useGitPushSyncStore.setState({ config: { ...DEFAULT_CONFIG, enabled: true } })
    render(<GitPushSyncSection />)
    await waitFor(() => expect(mocks.getGitStatus).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByLabelText('自动接收 app-server'))
    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ receivers: ['b'] }))
  })

  it('does not allow untrusted projects to receive updates', () => {
    mocks.isProjectTrusted.mockReturnValue(false)
    useGitPushSyncStore.setState({ config: { ...DEFAULT_CONFIG, enabled: true } })
    render(<GitPushSyncSection />)
    expect((screen.getByLabelText('自动接收 app-server') as HTMLInputElement).disabled).toBe(true)
  })
})
