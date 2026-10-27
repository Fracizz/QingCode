// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from './ProjectPicker'
import { useProjectStore } from '../store/projectStore'
import type { Project } from '../types'

vi.mock('./WorkspaceMenu', () => ({ default: () => null }))
vi.mock('./ProjectAddDialog', () => ({ default: () => null }))
vi.mock('../hooks/useProjectIndicators', () => ({
  useProjectIndicators: () => ({}),
  EMPTY_PROJECT_INDICATORS: { running: 0, dirtyEditors: 0, gitChanges: 0 },
}))

const initialState = useProjectStore.getState()
const projects: Project[] = ['Alpha', 'Beta', 'Gamma'].map((name, index) => ({
  id: name,
  name,
  kind: 'ssh',
  path: `ssh://test/home/${name}`,
  created_at: index,
  last_opened_at: index,
  sort_order: index,
  hidden: 0,
}))

function advance(ms = 1000) {
  act(() => vi.advanceTimersByTime(ms))
}

function chip(name: string) {
  return document.querySelector<HTMLElement>(`[data-chip-index][aria-label="${name}"]`)!
}

function hoverName(name: string, buttons = 0) {
  fireEvent.mouseEnter(chip(name).querySelector('span.block.truncate, span.block.min-w-0.truncate')!, { buttons })
}

function startDrag() {
  fireEvent.pointerDown(chip('Alpha'), { button: 0, clientX: 50, clientY: 12 })
  fireEvent.pointerMove(window, { buttons: 1, clientX: 290, clientY: 12 })
  advance(20)
}

describe('project chip drag tooltips', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('PointerEvent', MouseEvent)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(120)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    useProjectStore.setState({
      projects,
      currentProject: projects[0],
      sshConnections: [],
      unavailableProjectIds: [],
      reorderVisibleProjects: vi.fn().mockResolvedValue(undefined),
      switchProject: vi.fn().mockResolvedValue(true),
    })
  })

  afterEach(() => {
    fireEvent.keyDown(window, { key: 'Escape' })
    cleanup()
    useProjectStore.setState(initialState, true)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('removes an open tip and blocks all crossed chips until a fresh hover after drop', () => {
    render(<ProjectPicker />)
    hoverName('Beta')
    advance()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Beta')

    startDrag()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    for (const name of ['Beta', 'Gamma']) {
      hoverName(name, 1)
      advance()
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    }
    const hideButton = chip('Gamma').querySelector('button')!
    fireEvent.mouseEnter(hideButton, { buttons: 1 })
    advance()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.pointerUp(window, { button: 0, clientX: 290, clientY: 12 })
    advance()
    expect(useProjectStore.getState().reorderVisibleProjects).toHaveBeenCalledWith(0, 2)
    expect(useProjectStore.getState().switchProject).not.toHaveBeenCalled()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    hoverName('Gamma')
    advance()
    expect(screen.getAllByRole('tooltip')).toHaveLength(1)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Gamma')
  })

  it('cancels pending hover timers on drag and keeps them cleared after Escape', () => {
    render(<ProjectPicker />)
    hoverName('Beta')
    advance(300)
    startDrag()
    // Even a synthetic enter with no button state must respect the drag scope.
    hoverName('Gamma')
    advance()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    advance()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(useProjectStore.getState().reorderVisibleProjects).not.toHaveBeenCalled()
    hoverName('Beta')
    advance()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Beta')
  })

  it('does not open tips when entering a chip with a mouse button held', () => {
    render(<ProjectPicker />)
    hoverName('Beta', 1)
    advance()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    hoverName('Beta')
    advance()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Beta')
  })
})
