// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceSymbolPicker from './WorkspaceSymbolPicker'
import { useProjectStore } from '../store/projectStore'
import { useWorkspaceSymbolPickerStore } from '../store/workspaceSymbolPickerStore'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({
  searchWorkspaceSymbols: vi.fn(),
}))

vi.mock('../lib/symbolNavigation', () => ({
  searchWorkspaceSymbols: mocks.searchWorkspaceSymbols,
}))

const project: Project = {
  id: 'p1',
  name: 'Alpha',
  path: 'D:/alpha',
  created_at: 1,
  last_opened_at: 1,
  hidden: 0,
}

const initialProjectState = useProjectStore.getState()
const initialPickerState = useWorkspaceSymbolPickerStore.getState()

describe('WorkspaceSymbolPicker', () => {
  beforeEach(() => {
    mocks.searchWorkspaceSymbols.mockReset()
    mocks.searchWorkspaceSymbols.mockResolvedValue({
      definitions: [],
      filesIndexed: 1,
      complete: true,
      truncated: false,
    })
    useProjectStore.setState({ currentProject: project, projects: [project] })
    useWorkspaceSymbolPickerStore.setState({
      open: false,
      seedQuery: '',
    })
  })

  afterEach(() => {
    useProjectStore.setState(initialProjectState, true)
    useWorkspaceSymbolPickerStore.setState(initialPickerState, true)
  })

  it('prefills Ctrl+T with the selected editor symbol', async () => {
    useWorkspaceSymbolPickerStore.getState().openPicker('selectedName')
    render(<WorkspaceSymbolPicker />)

    await waitFor(() =>
      expect(screen.getByPlaceholderText('输入工作区符号名称…')).toHaveValue('selectedName')
    )
    await waitFor(() =>
      expect(mocks.searchWorkspaceSymbols).toHaveBeenCalledWith('D:/alpha', 'selectedName')
    )
  })
})
