// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RunPanel from './RunPanel'
import { useProjectStore } from '../store/projectStore'
import { useRunConfigStore, type RunConfig } from '../store/runConfigStore'
import { useTerminalStore } from '../store/terminalStore'
import { confirmDialog } from '../store/confirmStore'
import { removeRunConfigs } from '../lib/runConfigRuntime'
import type { Project } from '../types'

vi.mock('../lib/workspaceTrust', () => ({
  isProjectTrusted: () => true,
  isProjectRestricted: () => false,
  restrictProject: vi.fn(),
  trustProject: vi.fn(),
  pushTrustedRootsToNative: vi.fn(),
  WORKSPACE_TRUST_CHANGED_EVENT: 'test:workspace-trust',
}))
vi.mock('../store/confirmStore', () => ({ confirmDialog: vi.fn() }))
vi.mock('../lib/runConfigRuntime', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/runConfigRuntime')>()),
  rehydrateRunTerminals: vi.fn(),
  removeRunConfigs: vi.fn(),
}))

const project: Project = {
  id: 'p1',
  name: 'project',
  path: 'D:/project',
  created_at: 1,
  last_opened_at: 1,
}
const configs: RunConfig[] = [
  { id: 'dev', name: 'dev', tasks: [] },
  { id: 'test', name: 'test', tasks: [] },
  { id: 'prod', name: 'prod', tasks: [] },
]
const initialProjectState = useProjectStore.getState()
const initialConfigState = useRunConfigStore.getState()
const initialTerminalState = useTerminalStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(confirmDialog).mockResolvedValue(false)
  vi.mocked(removeRunConfigs).mockResolvedValue(undefined)
  useProjectStore.setState({ currentProject: project, projects: [project] })
  useRunConfigStore.setState({
    configsByProject: { p1: configs },
    loadConfigs: vi.fn(async p => useRunConfigStore.getState().configsByProject[p.id] ?? []),
  })
  useTerminalStore.setState({ terminals: [] })
})
afterEach(() => {
  useProjectStore.setState(initialProjectState, true)
  useRunConfigStore.setState(initialConfigState, true)
  useTerminalStore.setState(initialTerminalState, true)
})

describe('RunPanel batch deletion', () => {
  it('supports partial selection, select all, and clearing the selection', () => {
    render(<RunPanel />)
    const all = screen.getByRole('checkbox', { name: '全选运行配置' })
    fireEvent.click(screen.getByRole('checkbox', { name: '选择运行配置「dev」' }))
    expect(all).toBePartiallyChecked()
    expect(screen.getByText('已选 1 项')).toBeInTheDocument()
    fireEvent.click(all)
    expect(all).toBeChecked()
    expect(screen.getByText('已选 3 项')).toBeInTheDocument()
    fireEvent.click(all)
    expect(screen.getByText('已选 0 项')).toBeInTheDocument()
    fireEvent.click(all)
    fireEvent.click(screen.getByRole('button', { name: '取消选择' }))
    expect(screen.queryByRole('button', { name: '批量删除' })).not.toBeInTheDocument()
    expect(all).not.toBeChecked()
  })

  it('confirms once with the selected names and keeps the selection on cancellation', async () => {
    render(<RunPanel />)
    fireEvent.click(screen.getByRole('checkbox', { name: '选择运行配置「dev」' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择运行配置「test」' }))
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '批量删除' })).toBeEnabled())
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: '将删除选中的 2 个运行配置及其任务定义。',
        detail: 'dev\ntest\n\n删除后可在短时间内撤销。',
        kind: 'danger',
      })
    )
    expect(removeRunConfigs).not.toHaveBeenCalled()
    expect(screen.getByText('已选 2 项')).toBeInTheDocument()
  })

  it('warns about running terminals, deletes only the selection, and clears it on success', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true)
    useTerminalStore.setState({
      terminals: [
        {
          id: 'terminal',
          projectId: 'p1',
          name: 'dev',
          cwd: project.path,
          launchCommand: '',
          status: 'running',
          exitCode: null,
          runConfigId: 'dev',
        },
      ],
    })
    render(<RunPanel />)
    fireEvent.click(screen.getByRole('checkbox', { name: '选择运行配置「dev」' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择运行配置「test」' }))
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }))
    await waitFor(() =>
      expect(removeRunConfigs).toHaveBeenCalledExactlyOnceWith(project, ['dev', 'test'])
    )
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining('所选配置仍在运行。删除会先停止关联终端'),
      })
    )
    await waitFor(() => expect(screen.getByText('已选 0 项')).toBeInTheDocument())
  })

  it('keeps failed deletions selected and allows retrying', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true)
    vi.mocked(removeRunConfigs).mockRejectedValueOnce(new Error('write failed'))
    render(<RunPanel />)
    fireEvent.click(screen.getByRole('checkbox', { name: '全选运行配置' }))
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }))
    await waitFor(() => expect(removeRunConfigs).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '批量删除' })).toBeEnabled())
    expect(screen.getByText('已选 3 项')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }))
    await waitFor(() => expect(screen.getByText('已选 0 项')).toBeInTheDocument())
    expect(removeRunConfigs).toHaveBeenCalledTimes(2)
  })

  it('clears selection when switching projects even if config IDs are reused', () => {
    render(<RunPanel />)
    fireEvent.click(screen.getByRole('checkbox', { name: '全选运行配置' }))
    act(() => {
      useRunConfigStore.setState({ configsByProject: { p1: configs, p2: configs } })
      useProjectStore.setState({ currentProject: { ...project, id: 'p2', name: 'other' } })
    })
    expect(screen.getByText('已选 0 项')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '批量删除' })).not.toBeInTheDocument()
  })
})
