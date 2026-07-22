// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safeInvoke: vi.fn(),
  revealItemInDir: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  safeInvoke: mocks.safeInvoke,
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: mocks.revealItemInDir,
}))

vi.mock('react-window', () => ({
  List: () => null,
  useListRef: () => ({ current: null }),
}))

import SourceControlPanel from './SourceControlPanel'
import type { GitStatus } from '../lib/git'
import { useGitStatusStore } from '../store/gitStatusStore'
import { useProjectStore } from '../store/projectStore'
import { useSourceControlStore } from '../store/sourceControlStore'

const project = {
  id: 'repo-1',
  name: '仓库',
  path: 'D:/repo',
  created_at: 1,
  last_opened_at: 1,
}

const initialProjectState = useProjectStore.getState()

function mockGit(status: GitStatus, options?: { rejectFirstPush?: boolean }) {
  let pushes = 0
  mocks.safeInvoke.mockImplementation((_label: string, command: string) => {
    if (command === 'git_status') return Promise.resolve(status)
    if (command === 'git_log') return Promise.resolve([])
    if (command === 'git_commit') return Promise.resolve('abc123')
    if (command === 'git_stage') return Promise.resolve(undefined)
    if (command === 'git_push') {
      pushes += 1
      if (options?.rejectFirstPush && pushes === 1) return Promise.reject(new Error('认证失败'))
      return Promise.resolve('ok')
    }
    if (command === 'get_git_head') return Promise.resolve({ name: 'main' })
    return Promise.resolve(undefined)
  })
}

describe('SourceControlPanel', () => {
  beforeEach(() => {
    mocks.safeInvoke.mockReset()
    mocks.revealItemInDir.mockReset()
    useProjectStore.setState({ currentProject: project, projects: [project], toasts: [] })
    useSourceControlStore.getState().clearCache()
    useGitStatusStore.getState().clear()
  })

  afterEach(() => {
    useProjectStore.setState(initialProjectState, true)
    useSourceControlStore.getState().clearCache()
    useGitStatusStore.getState().clear()
  })

  it('stages all pending changes through the visible keyboard action', async () => {
    mockGit({
      is_repository: true,
      branch: 'main',
      changes: [{ path: 'src/app.ts', status: ' M' }],
    })
    render(<SourceControlPanel />)

    const stageAll = await screen.findByRole('button', { name: '所有文件添加至「待提交」' })
    fireEvent.click(stageAll)

    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith('暂存 Git 更改', 'git_stage', {
        path: project.path,
        files: [],
        all: true,
      })
    )
  })

  it('keeps the commit message and offers a retry when push fails', async () => {
    mockGit(
      {
        is_repository: true,
        branch: 'main',
        changes: [{ path: 'src/app.ts', status: 'M ' }],
      },
      { rejectFirstPush: true }
    )
    render(<SourceControlPanel />)

    const message = await screen.findByRole('textbox', { name: '提交信息' })
    fireEvent.change(message, { target: { value: 'feat: 保留提交信息' } })
    fireEvent.click(screen.getByRole('button', { name: /提交并推送到/ }))

    await screen.findByText(/提交成功，但推送失败：Error: 认证失败。提交信息已保留/)
    expect(message).toHaveValue('feat: 保留提交信息')
    const retry = screen.getByRole('button', { name: '重试推送' })
    fireEvent.click(retry)

    await waitFor(() =>
      expect(
        mocks.safeInvoke.mock.calls.filter(([, command]) => command === 'git_push')
      ).toHaveLength(2)
    )
    await waitFor(() => expect(message).toHaveValue(''))
  })

  it('ignores a late status response after switching projects', async () => {
    let resolveFirstStatus: ((status: GitStatus) => void) | undefined
    mocks.safeInvoke.mockImplementation(
      (_label: string, command: string, args?: { path: string }) => {
        if (command === 'git_status' && args?.path === project.path) {
          return new Promise<GitStatus>(resolve => {
            resolveFirstStatus = resolve
          })
        }
        if (command === 'git_status') {
          return Promise.resolve({ is_repository: true, branch: 'new-project', changes: [] })
        }
        if (command === 'git_log') return Promise.resolve([])
        return Promise.resolve(undefined)
      }
    )
    render(<SourceControlPanel />)

    const nextProject = { ...project, id: 'repo-2', path: 'D:/other', name: '另一个仓库' }
    useProjectStore.setState({ currentProject: nextProject, projects: [project, nextProject] })
    await screen.findByText('new-project')

    resolveFirstStatus?.({ is_repository: true, branch: 'old-project', changes: [] })
    await waitFor(() => expect(screen.queryByText('old-project')).not.toBeInTheDocument())
    expect(screen.getByText('new-project')).toBeInTheDocument()
  })
})
