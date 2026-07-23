// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import ProjectManager from './ProjectManager'
import { useProjectStore } from '../store/projectStore'

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

describe('ProjectManager', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [visibleProject, hiddenProject],
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

  it('activates a project by clicking its name button', async () => {
    render(<ProjectManager />)
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
    // handleActivate awaits unhideProject (hidden project) then switchProject.
    await waitFor(() =>
      expect(useProjectStore.getState().switchProject).toHaveBeenCalledWith(hiddenProject)
    )
    expect(useProjectStore.getState().unhideProject).toHaveBeenCalledWith(hiddenProject.id)
  })
})
