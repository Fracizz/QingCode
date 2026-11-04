// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectIdleEditor from './ProjectIdleEditor'
import { useCommandPaletteStore } from '../store/commandPaletteStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'

const project = { id: 'p', name: 'qingcode', path: 'D:\\code\\qingcode', created_at: 1, last_opened_at: 1 }
const initialProjects = useProjectStore.getState()
const initialEditor = useEditorStore.getState()

beforeEach(() => {
  useProjectStore.setState({
    projects: [project],
    currentProject: project,
    recentFiles: [
      { project_id: 'p', path: 'D:\\code\\qingcode\\DESIGN.md', opened_at: 3 },
      { project_id: 'p', path: 'D:\\code\\qingcode\\src\\lib\\editorSurface.ts', opened_at: 2 },
      { project_id: 'other', path: 'D:\\other\\leak.ts', opened_at: 1 },
    ],
  })
})
afterEach(() => {
  useProjectStore.setState(initialProjects, true)
  useEditorStore.setState(initialEditor, true)
  useCommandPaletteStore.getState().closePalette()
})

describe('ProjectIdleEditor', () => {
  it('lists only this project\'s recent files with root-relative folders', () => {
    render(<ProjectIdleEditor />)
    expect(screen.getByText('DESIGN.md')).toBeInTheDocument()
    expect(screen.getByText('editorSurface.ts')).toBeInTheDocument()
    expect(screen.getByText('src/lib')).toBeInTheDocument()
    expect(screen.queryByText('leak.ts')).not.toBeInTheDocument()
  })

  it('reopens a recent file on click', () => {
    const openFile = vi.fn(async () => {})
    useEditorStore.setState({ openFile } as never)
    render(<ProjectIdleEditor />)
    fireEvent.click(screen.getByText('DESIGN.md'))
    expect(openFile).toHaveBeenCalledWith('D:\\code\\qingcode\\DESIGN.md')
  })

  it('opens quick open and new file from the actions', () => {
    render(<ProjectIdleEditor />)
    fireEvent.click(screen.getByText('快速打开文件'))
    expect(useCommandPaletteStore.getState().open).toBe(true)
    fireEvent.click(screen.getByText('新建文件'))
    expect(useUIStore.getState().pendingNewFile).toBe(true)
  })
})
