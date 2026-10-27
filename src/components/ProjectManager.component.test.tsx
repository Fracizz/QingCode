// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, SshConnection } from '../types'
import ProjectManager from './ProjectManager'
import { useProjectStore } from '../store/projectStore'
import { saveSelectedProjectsAsWorkspace } from '../lib/namedWorkspaceActions'
import { removeProjectWithConfirm } from '../utils/projectActions'
import { confirmDialog } from '../store/confirmStore'

// Per-row trust reads come from this module; stub a stable "trusted" level and
// no-op the trust mutations so the row action buttons render deterministically.
vi.mock('../lib/workspaceTrust', () => ({
  getWorkspaceTrust: () => 'trusted',
  restrictProject: vi.fn(),
  trustProject: vi.fn(),
  untrustProject: vi.fn(),
  pushTrustedRootsToNative: vi.fn(),
  WORKSPACE_TRUST_CHANGED_EVENT: 'qingcode:workspace-trust-changed',
}))

// The confirm/relocate/rename/add-terminal flows are driven through these utils;
// stub them so the hide/unhide paths (which call store actions directly) stay isolated.
vi.mock('../utils/projectActions', () => ({
  removeProjectWithConfirm: vi.fn(),
  relocateProjectWithDialog: vi.fn(),
  addTerminalProjectWithPrompt: vi.fn(),
  renameProjectWithPrompt: vi.fn(),
}))

vi.mock('../lib/namedWorkspaceActions', () => ({
  saveSelectedProjectsAsWorkspace: vi.fn(),
}))

vi.mock('../store/confirmStore', () => ({
  confirmDialog: vi.fn().mockResolvedValue(false),
}))

const visibleProject: Project = {
  id: 'p1',
  name: 'Alpha',
  path: 'D:/alpha',
  created_at: 1,
  last_opened_at: 1,
  hidden: 0,
}

const hiddenProject: Project = {
  id: 'p2',
  name: 'Beta',
  path: 'D:/beta',
  created_at: 1,
  last_opened_at: 1,
  hidden: 1,
}

const initialProjectState = useProjectStore.getState()

function makeProjects(count = 17): Project[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `project-${index + 1}`,
    name: `Project ${String(index + 1).padStart(2, '0')}`,
    path: `D:/projects/project-${index + 1}`,
    created_at: index + 1,
    last_opened_at: 100 - index,
    hidden: index < 4 ? 0 : 1,
  }))
}

function sourceFixtures() {
  const connections: SshConnection[] = [
    {
      id: 'wsl',
      name: 'WSL',
      host: 'localhost',
      port: 22,
      username: 'root',
      auth_kind: 'privateKey',
      host_key_fingerprint: 'fp',
      created_at: 1,
      updated_at: 1,
    },
    {
      id: 'win',
      name: 'WinDev',
      host: '192.168.252.107',
      port: 28822,
      username: 'administrator',
      auth_kind: 'privateKey',
      host_key_fingerprint: 'fp',
      created_at: 1,
      updated_at: 1,
    },
  ]
  const projects: Project[] = [
    visibleProject,
    {
      ...visibleProject,
      id: 'ubuntu',
      name: 'Ubuntu app',
      path: String.raw`\\wsl$\Ubuntu\home\code\app`,
    },
    {
      ...hiddenProject,
      id: 'debian',
      name: 'Debian app',
      path: 'wsl://Debian/home/code/app',
      kind: 'wsl',
    },
    {
      ...visibleProject,
      id: 'ssh-wsl',
      name: 'Remote app',
      kind: 'ssh',
      path: 'ssh://wsl/home/code/remote',
      root_path: '/home/code/remote',
    },
    {
      ...hiddenProject,
      id: 'ssh-win',
      name: 'Windows app',
      kind: 'ssh',
      connection_id: 'win',
      path: 'ssh://win/D:/code/app',
      root_path: '/D:/code/app',
    },
  ]
  return { projects, sshConnections: connections }
}

describe('ProjectManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProjectStore.setState({
      projects: [visibleProject, hiddenProject],
      sshConnections: [],
      currentProject: visibleProject,
      unavailableProjectIds: [],
      toasts: [],
      hideProject: vi.fn().mockResolvedValue(undefined),
      unhideProject: vi.fn().mockResolvedValue(undefined),
      switchProject: vi.fn().mockResolvedValue(true),
      addProjectFromDialog: vi.fn().mockResolvedValue(undefined),
    })
  })

  afterEach(() => {
    useProjectStore.setState(initialProjectState, true)
  })

  it('renders the durable project list', () => {
    render(<ProjectManager />)
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument()
  })

  it('describes project removal without suggesting that files will be deleted', async () => {
    render(<ProjectManager />)
    expect(screen.queryByRole('button', { name: '永久删除' })).not.toBeInTheDocument()
    expect(screen.getByText(/移除项目不会删除磁盘文件/)).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '移除项目' })[0])
    expect(removeProjectWithConfirm).toHaveBeenCalledWith(
      visibleProject.id,
      visibleProject.name,
      visibleProject.path
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前页' }))
    fireEvent.click(screen.getByRole('button', { name: '批量移除' }))
    await waitFor(() =>
      expect(confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '批量移除项目',
          message: '确定从项目列表移除选中的 2 个项目？',
          confirmLabel: '移除',
          kind: 'warning',
        })
      )
    )
  })

  it('hides a visible project through the row action button', async () => {
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('button', { name: '从顶栏隐藏' }))
    expect(useProjectStore.getState().hideProject).toHaveBeenCalledWith(visibleProject.id)
  })

  it('restores a hidden project through the row action button', async () => {
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('button', { name: '恢复显示' }))
    expect(useProjectStore.getState().unhideProject).toHaveBeenCalledWith(hiddenProject.id)
  })

  it('renders SSH paths with the same mono auxiliary style as local paths', () => {
    const sshProject: Project = {
      id: 'p-ssh',
      name: 'ai-auto-test-dev',
      path: 'ssh://c451183d-a3b4-4c53-ab3c-fae6b0000001/root/.claude',
      kind: 'ssh',
      connection_id: 'conn-1',
      root_path: '/root/.claude',
      created_at: 3,
      last_opened_at: 3,
    }
    useProjectStore.setState({
      projects: [visibleProject, sshProject],
      currentProject: sshProject,
      sshConnections: [
        {
          id: 'conn-1',
          name: 'wsl',
          host: 'localhost',
          port: 22,
          username: 'root',
          auth_kind: 'privateKey',
          created_at: 1,
          updated_at: 1,
        },
      ],
    })
    render(<ProjectManager />)
    const path = screen.getByText('root@localhost:/root/.claude')
    expect(path.className).toMatch(/font-mono/)
    expect(path).toHaveClass('text-ui-sm')
    expect(screen.queryByText(/ssh:\/\/c451183d/)).not.toBeInTheDocument()
  })

  it('renders WSL project with cloud icon and WSL badge', () => {
    const wslProject: Project = {
      id: 'p-wsl',
      name: 'QingCode',
      path: String.raw`\\wsl$\Ubuntu\home\code\QingCode`,
      kind: 'wsl',
      created_at: 4,
      last_opened_at: 4,
      hidden: 0,
    }
    useProjectStore.setState({
      projects: [visibleProject, wslProject],
      currentProject: visibleProject,
    })
    render(<ProjectManager />)
    expect(screen.getByText('WSL', { selector: 'span' })).toBeInTheDocument()
    expect(document.querySelector('.lucide-cloud')).toBeInTheDocument()
  })

  it('activates a project by clicking its name button', async () => {
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
    // handleActivate awaits unhideProject (hidden project) then switchProject.
    await waitFor(() =>
      expect(useProjectStore.getState().switchProject).toHaveBeenCalledWith(hiddenProject)
    )
    expect(useProjectStore.getState().unhideProject).toHaveBeenCalledWith(hiddenProject.id)
  })

  it('defaults to ten durable projects per page and shows the remaining seven on the next page', () => {
    useProjectStore.setState({
      projects: [...makeProjects(), { ...visibleProject, ephemeral: true }],
    })
    render(<ProjectManager />)
    expect(screen.getByLabelText('每页显示')).toHaveValue('10')
    expect(screen.getAllByRole('row')).toHaveLength(11)
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-10 项，共 17 项')
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Project 11' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getAllByRole('row')).toHaveLength(8)
    expect(screen.getByRole('button', { name: 'Project 11' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('显示 11-17 项，共 17 项')
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    expect(screen.getByRole('button', { name: 'Project 01' })).toBeInTheDocument()
  })

  it('resets to the first page when the page size changes', () => {
    useProjectStore.setState({ projects: makeProjects(25) })
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.change(screen.getByLabelText('每页显示'), { target: { value: '20' } })
    expect(screen.getAllByRole('row')).toHaveLength(21)
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-20 项，共 25 项')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByRole('status')).toHaveTextContent('显示 21-25 项，共 25 项')
    fireEvent.change(screen.getByLabelText('每页显示'), { target: { value: '50' } })
    expect(screen.getAllByRole('row')).toHaveLength(26)
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  })

  it('resets pagination for filtering and sorts the full list before paging', () => {
    useProjectStore.setState({ projects: makeProjects() })
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.click(screen.getByRole('tab', { name: '已显示' }))
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-4 项，共 4 项')
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: '已隐藏' }))
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-10 项，共 13 项')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.click(screen.getByRole('button', { name: '名称' }))
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-10 项，共 13 项')
    expect(screen.getByRole('button', { name: 'Project 05' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '名称' }))
    expect(screen.getByRole('button', { name: 'Project 17' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Project 05' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.change(screen.getByLabelText('项目排序'), { target: { value: 'created_at' } })
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.click(screen.getByRole('button', { name: '切换排序方向' }))
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
  })

  it('selects only the current page and preserves other pages for batch workspace saving', () => {
    const projects = makeProjects()
    useProjectStore.setState({ projects })
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前页' }))
    expect(screen.getByText('已选 10 项')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByRole('checkbox', { name: '全选当前页' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前页' }))
    expect(screen.getByText('已选 17 项')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存选中为多项目工作区' }))
    expect(saveSelectedProjectsAsWorkspace).toHaveBeenCalledWith(
      projects.map(project => project.id)
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前页' }))
    expect(screen.getByText('已选 10 项')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    expect(screen.getByRole('checkbox', { name: '全选当前页' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    fireEvent.click(screen.getByRole('tab', { name: '已显示' }))
    return waitFor(() => expect(screen.getByText('已选 4 项')).toBeInTheDocument())
  })

  it('clamps the page when projects are removed and keeps that page when projects are added again', async () => {
    const projects = makeProjects()
    useProjectStore.setState({ projects })
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await act(async () => useProjectStore.setState({ projects: projects.slice(0, 10) }))
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-10 项，共 10 项')
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    await act(async () => useProjectStore.setState({ projects }))
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-10 项，共 17 项')
  })

  it('shows a zero range and disables navigation for an empty filtered list', () => {
    useProjectStore.setState({ projects: [hiddenProject] })
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('tab', { name: '已显示' }))
    expect(screen.getByRole('status')).toHaveTextContent('显示 0-0 项，共 0 项')
    expect(screen.getByText('第 1 / 1 页')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  })

  it('searches local and SSH project names without case sensitivity and can clear the search', () => {
    const remoteProject: Project = {
      ...hiddenProject,
      id: 'remote',
      name: 'Alpha-远程项目',
      path: 'ssh://connection/home/code/remote',
      kind: 'ssh',
      root_path: '/home/code/remote',
      connection_id: 'connection',
    }
    useProjectStore.setState({
      projects: [visibleProject, hiddenProject, remoteProject],
    })
    render(<ProjectManager />)
    const search = screen.getByRole('textbox', { name: '搜索项目名称、路径或来源' })
    fireEvent.change(search, { target: { value: '  aLPHa  ' } })
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Alpha-远程项目' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Beta' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-2 项，共 2 项')
    fireEvent.change(search, { target: { value: '远程' } })
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-1 项，共 1 项')
    fireEvent.change(search, { target: { value: '/home/code' } })
    expect(screen.getByRole('button', { name: 'Alpha-远程项目' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-1 项，共 1 项')
    fireEvent.change(search, { target: { value: 'no-such-project' } })
    expect(screen.getByText('没有匹配的项目')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('显示 0-0 项，共 0 项')
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(search).toHaveValue('')
    expect(search).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-3 项，共 3 项')
  })

  it('searches across all pages and combines the results with visibility filtering and sorting', () => {
    useProjectStore.setState({ projects: makeProjects() })
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    const search = screen.getByRole('textbox', { name: '搜索项目名称、路径或来源' })
    fireEvent.change(search, { target: { value: 'project' } })
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-10 项，共 17 项')
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    fireEvent.change(search, { target: { value: 'project 0' } })
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-9 项，共 9 项')
    fireEvent.click(screen.getByRole('tab', { name: '已显示' }))
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-4 项，共 4 项')
    fireEvent.click(screen.getByRole('tab', { name: '已隐藏' }))
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-5 项，共 5 项')
    fireEvent.click(screen.getByRole('button', { name: '名称' }))
    fireEvent.click(screen.getByRole('button', { name: '名称' }))
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Project 09')
    fireEvent.change(search, { target: { value: 'project 17' } })
    expect(screen.getByRole('button', { name: 'Project 17' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-1 项，共 1 项')
  })

  it('drops selections outside the search results before saving the selected workspace', async () => {
    useProjectStore.setState({ projects: makeProjects() })
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前页' }))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索项目名称、路径或来源' }), {
      target: { value: 'project 01' },
    })
    await waitFor(() => expect(screen.getByText('已选 1 项')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '保存选中为多项目工作区' }))
    expect(saveSelectedProjectsAsWorkspace).toHaveBeenCalledWith(['project-1'])
  })

  it('searches paths, distributions, and connection metadata even for unique project names', () => {
    useProjectStore.setState(sourceFixtures())
    render(<ProjectManager />)
    const search = screen.getByRole('textbox', { name: '搜索项目名称、路径或来源' })
    for (const [query, expected] of [
      ['  WINDEV  ', 'Windows app'],
      ['192.168.252.107:28822', 'Windows app'],
      ['administrator', 'Windows app'],
      ['root@localhost', 'Remote app'],
      ['/home/code/remote', 'Remote app'],
      ['Ubuntu', 'Ubuntu app'],
      ['本机', 'Alpha'],
    ]) {
      fireEvent.change(search, { target: { value: query } })
      expect(screen.getByRole('button', { name: expected })).toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('显示 1-1 项，共 1 项')
    }
    fireEvent.change(search, { target: { value: '/home/code/app' } })
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-2 项，共 2 项')
    fireEvent.change(search, { target: { value: 'WSL' } })
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-3 项，共 3 项')
  })

  it('filters native WSL separately from SSH connections named WSL and combines conditions', () => {
    useProjectStore.setState(sourceFixtures())
    render(<ProjectManager />)
    const source = screen.getByLabelText('筛选项目来源')
    fireEvent.change(source, { target: { value: 'wsl' } })
    expect(screen.getByRole('button', { name: 'Ubuntu app' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Debian app' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remote app' })).not.toBeInTheDocument()
    fireEvent.change(source, { target: { value: 'wsl:Ubuntu' } })
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-1 项，共 1 项')
    fireEvent.change(source, { target: { value: 'ssh' } })
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-2 项，共 2 项')
    fireEvent.change(source, { target: { value: 'ssh:wsl' } })
    expect(screen.getByRole('button', { name: 'Remote app' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-1 项，共 1 项')
    fireEvent.change(source, { target: { value: 'ssh:win' } })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/D:/code' } })
    fireEvent.click(screen.getByRole('tab', { name: '已隐藏' }))
    expect(screen.getByRole('button', { name: 'Windows app' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '已显示' }))
    expect(screen.getByText('没有匹配的项目')).toBeInTheDocument()
    fireEvent.change(source, { target: { value: 'all' } })
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-3 项，共 3 项')
    fireEvent.change(source, { target: { value: 'local' } })
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-1 项，共 1 项')
  })

  it('resets pagination and removes selections outside the selected source', async () => {
    const fixtures = sourceFixtures()
    useProjectStore.setState({ ...fixtures, projects: [...makeProjects(), ...fixtures.projects] })
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前页' }))
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.change(screen.getByLabelText('筛选项目来源'), { target: { value: 'ssh' } })
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('显示 1-2 项，共 2 项')
    await waitFor(() => expect(screen.queryByText('已选 10 项')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前页' }))
    fireEvent.change(screen.getByLabelText('筛选项目来源'), { target: { value: 'ssh:win' } })
    await waitFor(() => expect(screen.getByText('已选 1 项')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '保存选中为多项目工作区' }))
    expect(saveSelectedProjectsAsWorkspace).toHaveBeenCalledWith(['ssh-win'])
  })
})
