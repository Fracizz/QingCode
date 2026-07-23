// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

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
  List: ({
    rowCount,
    rowComponent: Row,
    rowProps,
  }: {
    rowCount: number
    rowComponent: (props: Record<string, unknown>) => ReactElement | null
    rowProps: Record<string, unknown>
  }) => (
    <div>
      {Array.from({ length: rowCount }, (_, index) => (
        <Row
          key={index}
          index={index}
          style={{}}
          ariaAttributes={{
            'aria-posinset': index + 1,
            'aria-setsize': rowCount,
            role: 'listitem',
          }}
          {...rowProps}
        />
      ))}
    </div>
  ),
  useListRef: () => ({ current: null }),
}))

vi.mock('./ScmInlineDiff', () => ({
  default: ({ name, modified }: { name: string; modified: string }) => (
    <div data-testid="scm-inline-diff">
      {name}:{modified}
    </div>
  ),
}))

import SourceControlPanel from './SourceControlPanel'
import ConfirmDialog from './ConfirmDialog'
import type { GitStatus } from '../lib/git'
import { useConfirmStore } from '../store/confirmStore'
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
    if (command === 'get_git_workdir_status') {
      return Promise.resolve({
        entries: status.changes.map(change => ({
          path: `${project.path}/${change.path}`,
          status: change.status,
        })),
        dirty_count: status.changes.length,
      })
    }
    if (command === 'git_file_contents') {
      return Promise.resolve({ original: '', modified: 'stale-working-tree' })
    }
    if (command === 'file_stat') {
      return Promise.resolve({ size: 16, is_dir: false })
    }
    if (command === 'git_discard') return Promise.resolve(undefined)
    return Promise.resolve(undefined)
  })
}

describe('SourceControlPanel', () => {
  beforeEach(() => {
    mocks.safeInvoke.mockReset()
    mocks.revealItemInDir.mockReset()
    useConfirmStore.getState().answer(false)
    useProjectStore.setState({ currentProject: project, projects: [project], toasts: [] })
    useSourceControlStore.getState().clearCache()
    useGitStatusStore.getState().clear()
  })

  afterEach(() => {
    useProjectStore.setState(initialProjectState, true)
    useSourceControlStore.getState().clearCache()
    useGitStatusStore.getState().clear()
    useConfirmStore.getState().answer(false)
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

  it('clears the inline diff pane after discarding the selected change', async () => {
    let workdir: GitStatus = {
      is_repository: true,
      branch: 'main',
      changes: [{ path: 'src/app.ts', status: '??' }],
    }
    mocks.safeInvoke.mockImplementation((_label: string, command: string) => {
      if (command === 'git_status') return Promise.resolve(workdir)
      if (command === 'git_log') return Promise.resolve([])
      if (command === 'get_git_head') return Promise.resolve({ name: 'main' })
      if (command === 'get_git_workdir_status') {
        return Promise.resolve({
          entries: workdir.changes.map(change => ({
            path: `${project.path}/${change.path}`,
            status: change.status,
          })),
          dirty_count: workdir.changes.length,
        })
      }
      if (command === 'git_file_contents') {
        return Promise.resolve({ original: '', modified: 'stale-working-tree' })
      }
      if (command === 'file_stat') {
        return Promise.resolve({ size: 16, is_dir: false })
      }
      if (command === 'git_discard') {
        workdir = { is_repository: true, branch: 'main', changes: [] }
        return Promise.resolve(undefined)
      }
      return Promise.resolve(undefined)
    })

    render(
      <>
        <SourceControlPanel />
        <ConfirmDialog />
      </>
    )

    const row = await screen.findByText('src/app.ts')
    fireEvent.click(row)
    expect(await screen.findByTestId('scm-inline-diff')).toHaveTextContent('stale-working-tree')

    fireEvent.contextMenu(row.closest('button') ?? row)
    fireEvent.click(await screen.findByRole('menuitem', { name: '丢弃更改' }))
    fireEvent.click(await screen.findByRole('button', { name: '丢弃' }))

    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith('丢弃 Git 更改', 'git_discard', {
        path: project.path,
        files: ['src/app.ts'],
        staged: false,
      })
    )
    await waitFor(() => expect(screen.queryByTestId('scm-inline-diff')).not.toBeInTheDocument())
    expect(screen.getByText('选择一个更改查看差异')).toBeInTheDocument()
    expect(screen.getByText('变更（0）')).toBeInTheDocument()
  })
})
