// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import ProjectAddDialog from './ProjectAddDialog'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'

const first: Project = {
  id: 'first',
  name: '项目 A',
  path: 'D:/projects/a',
  created_at: 1,
  last_opened_at: 1,
}
const second: Project = {
  id: 'second',
  name: '项目 B',
  path: 'D:/projects/b',
  created_at: 2,
  last_opened_at: 2,
}

const initialProjectState = useProjectStore.getState()
const initialUIState = useUIStore.getState()

describe('ProjectAddDialog', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [first, second],
      currentProject: first,
      unavailableProjectIds: [],
    })
  })

  afterEach(() => {
    useProjectStore.setState(initialProjectState, true)
    useUIStore.setState(initialUIState, true)
  })

  it('switches projects through the keyboard-accessible project picker', async () => {
    const switchProject = vi.fn().mockResolvedValue(true)
    const onClose = vi.fn()
    useProjectStore.setState({ switchProject })

    render(<ProjectAddDialog open onClose={onClose} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-labelledby', 'project-add-title')
    expect(dialog).toHaveAttribute('aria-describedby', 'project-add-description')
    expect(screen.getByRole('textbox')).toHaveFocus()

    fireEvent.click(screen.getByRole('option', { name: '项目 B — D:/projects/b' }))
    await waitFor(() => expect(switchProject).toHaveBeenCalledWith(second))
    expect(onClose).toHaveBeenCalledOnce()
    expect(useUIStore.getState().view).toBe('explorer')
  })

  it('marks SSH projects in the picker list', () => {
    useProjectStore.setState({
      projects: [
        first,
        {
          id: 'ssh-1',
          name: '远程仓库',
          path: 'ssh://c1/root/.claude',
          kind: 'ssh',
          connection_id: 'c1',
          root_path: '/root/.claude',
          created_at: 3,
          last_opened_at: 3,
        },
      ],
      sshConnections: [
        {
          id: 'c1',
          name: 'dev-server',
          host: 'remotehost',
          port: 22,
          username: 'root',
          auth_kind: 'privateKey',
          host_key_fingerprint: 'fp',
          created_at: 1,
          updated_at: 1,
        },
      ],
    })
    render(<ProjectAddDialog open onClose={vi.fn()} />)

    expect(
      screen.getByRole('option', { name: '远程仓库 — root@remotehost:/root/.claude' })
    ).toHaveTextContent('SSH')
  })

  it('marks SSH projects on a connection named WSL with an SSH badge', () => {
    useProjectStore.setState({
      projects: [
        first,
        {
          id: 'ssh-wsl',
          name: 'QingCode',
          path: 'ssh://conn-wsl/home/code/QingCode',
          kind: 'ssh',
          connection_id: 'conn-wsl',
          root_path: '/home/code/QingCode',
          created_at: 3,
          last_opened_at: 3,
        },
      ],
      sshConnections: [
        {
          id: 'conn-wsl',
          name: 'WSL',
          host: 'localhost',
          port: 22,
          username: 'franciz',
          auth_kind: 'privateKey',
          host_key_fingerprint: 'fp',
          created_at: 1,
          updated_at: 1,
        },
      ],
    })
    render(<ProjectAddDialog open onClose={vi.fn()} />)

    const wslOption = screen.getByRole('option', {
      name: 'QingCode — franciz@localhost:/home/code/QingCode',
    })
    expect(wslOption).toHaveTextContent('SSH')
    expect(wslOption).not.toHaveTextContent('WSL')
    expect(document.querySelector('.lucide-cloud')).toBeInTheDocument()
  })

  it('hands off to the unified create-project dialog instead of stacking overlays', () => {
    const onClose = vi.fn()
    render(<ProjectAddDialog open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(useUIStore.getState().createProjectOpen).toBe(true)
  })

  it('opens the remote connections manager from the footer', () => {
    const onClose = vi.fn()
    render(<ProjectAddDialog open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: '远程连接' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(useUIStore.getState()).toMatchObject({
      remoteConnectionsOpen: true,
      remoteConnectionsCreating: false,
    })
  })
})
