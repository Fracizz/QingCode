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

  it('replaces the project picker with the SSH dialog instead of stacking overlays', () => {
    render(<ProjectAddDialog open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'SSH' }))

    expect(screen.getByRole('dialog', { name: '打开 SSH 项目' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '选择项目' })).not.toBeInTheDocument()
  })
})
