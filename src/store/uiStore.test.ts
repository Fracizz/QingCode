import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_LAYOUT_KEY } from '../lib/panelLayoutTemplate'
import { SIDE_WORKSPACE_KEY } from '../lib/sideWorkspaceLayout'
import { useUIStore } from './uiStore'

const memory = new Map<string, string>()

beforeEach(() => {
  memory.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value)
    },
  })
  vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  useUIStore.setState({
    panelLayout: 'classic',
    panelLayoutSwitching: false,
    sideDualTerminal: false,
    sideQuadTerminal: false,
    sideEditorVisible: true,
    terminalOpenSignal: 0,
    view: 'explorer',
    sidebarOpen: true,
    fullPageRestore: null,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('finishCreateProject', () => {
  it('closes the create dialog and the project manager it was opened from', () => {
    useUIStore.setState({ createProjectOpen: true, projectManagerOpen: true, view: 'search' })
    useUIStore.getState().finishCreateProject()
    const state = useUIStore.getState()
    expect(state.createProjectOpen).toBe(false)
    expect(state.projectManagerOpen).toBe(false)
    expect(state.view).toBe('explorer')
  })
})

describe('showExplorerViewKeepingSidebar', () => {
  it('leaves a collapsed sidebar collapsed', () => {
    useUIStore.setState({ view: 'sourceControl', sidebarOpen: false })
    useUIStore.getState().showExplorerViewKeepingSidebar()
    expect(useUIStore.getState().view).toBe('explorer')
    expect(useUIStore.getState().sidebarOpen).toBe(false)
  })
})

describe('setPanelLayoutMode', () => {
  it('applies dual+editor presets', () => {
    useUIStore.getState().setPanelLayoutMode('sideDualEditor')
    expect(useUIStore.getState().panelLayout).toBe('sideTerminal')
    expect(useUIStore.getState().sideDualTerminal).toBe(true)
    expect(useUIStore.getState().sideQuadTerminal).toBe(false)
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
    expect(JSON.parse(memory.get(SIDE_WORKSPACE_KEY) ?? '{}')).toEqual({
      dualTerminal: true,
      quadTerminal: false,
      editorVisible: true,
    })
    expect(memory.get(PANEL_LAYOUT_KEY)).toBe('sideTerminal')
  })

  it('maps legacy sideDual to dual+editor', () => {
    useUIStore.getState().setPanelLayoutMode('sideDual')
    expect(useUIStore.getState().sideDualTerminal).toBe(true)
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
  })

  it('side terminal preset clears dual and shows editor', () => {
    useUIStore.getState().setPanelLayoutMode('sideDualEditor')
    useUIStore.setState({ panelLayoutSwitching: false })
    useUIStore.getState().setPanelLayoutMode('sideTerminal')
    expect(useUIStore.getState().sideDualTerminal).toBe(false)
    expect(useUIStore.getState().sideQuadTerminal).toBe(false)
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
  })
})

describe('terminal workbench', () => {
  it('opens the terminal list with the editor collapsed and keeps dual flags for later', () => {
    useUIStore.setState({ sideDualTerminal: true, sideEditorVisible: true })
    useUIStore.getState().setPanelLayoutMode('terminalWorkbench')
    const state = useUIStore.getState()
    expect(state.panelLayout).toBe('terminalWorkbench')
    expect(state.view).toBe('terminals')
    expect(state.sidebarOpen).toBe(true)
    expect(state.sideEditorVisible).toBe(false)
    expect(state.sideDualTerminal).toBe(true)
    expect(memory.get(PANEL_LAYOUT_KEY)).toBe('terminalWorkbench')
    expect(JSON.parse(memory.get(SIDE_WORKSPACE_KEY) ?? '{}').editorVisible).toBe(false)
  })

  it('stays on the preset while the editor is toggled', () => {
    useUIStore.getState().setPanelLayoutMode('terminalWorkbench')
    useUIStore.getState().toggleSideEditorVisible()
    useUIStore.setState({ view: 'explorer' })
    useUIStore.getState().setPanelLayoutMode('terminalWorkbench')
    // 已处于该预设时再次选择不重置视图和编辑器。
    expect(useUIStore.getState().view).toBe('explorer')
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
  })

  it('leaves the terminal list view when switching to another preset', () => {
    useUIStore.getState().setPanelLayoutMode('terminalWorkbench')
    useUIStore.getState().setPanelLayoutMode('classic')
    expect(useUIStore.getState().view).toBe('explorer')
  })

  it('takes over from a full-page view on entry', () => {
    useUIStore.getState().setView('settings')
    useUIStore.getState().setPanelLayoutMode('terminalWorkbench')
    const state = useUIStore.getState()
    expect(state.view).toBe('terminals')
    expect(state.fullPageRestore).toBeNull()
    expect(state.sideEditorVisible).toBe(false)
  })

  it('returns to the list and re-collapses the editor after a full-page view', () => {
    useUIStore.getState().setPanelLayoutMode('terminalWorkbench')
    useUIStore.getState().toggleActivityView('sourceControl')
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
    useUIStore.getState().toggleActivityView('sourceControl')
    expect(useUIStore.getState().view).toBe('terminals')
    expect(useUIStore.getState().sideEditorVisible).toBe(false)
  })

  it('collapses the editor only when empty inside the workbench', () => {
    useUIStore.getState().collapseEmptyWorkbenchEditor()
    expect(useUIStore.getState().sideEditorVisible).toBe(true)

    useUIStore.getState().setPanelLayoutMode('terminalWorkbench')
    useUIStore.getState().expandSideEditor()
    useUIStore.getState().collapseEmptyWorkbenchEditor()
    expect(useUIStore.getState().sideEditorVisible).toBe(false)
  })

  it('keeps the shared column during a full-page view', () => {
    useUIStore.getState().setPanelLayoutMode('terminalWorkbench')
    useUIStore.getState().setView('settings')
    useUIStore.getState().collapseEmptyWorkbenchEditor()
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
  })

  it('keeps the list when switching projects, except from the file tree', () => {
    useUIStore.getState().setPanelLayoutMode('terminalWorkbench')
    useUIStore.getState().showExplorerViewKeepingSidebar()
    expect(useUIStore.getState().view).toBe('terminals')
    useUIStore.setState({ view: 'explorer' })
    useUIStore.getState().showExplorerViewKeepingSidebar()
    expect(useUIStore.getState().view).toBe('explorer')
  })
})

describe('togglePanelLayout', () => {
  it('cycles classic → side → dual+editor → workbench', () => {
    useUIStore.getState().togglePanelLayout()
    expect(useUIStore.getState().panelLayout).toBe('sideTerminal')
    expect(useUIStore.getState().sideDualTerminal).toBe(false)
    expect(useUIStore.getState().sideEditorVisible).toBe(true)

    useUIStore.setState({ panelLayoutSwitching: false })
    useUIStore.getState().togglePanelLayout()
    expect(useUIStore.getState().sideDualTerminal).toBe(true)
    expect(useUIStore.getState().sideEditorVisible).toBe(true)

    useUIStore.getState().togglePanelLayout()
    expect(useUIStore.getState().panelLayout).toBe('terminalWorkbench')

    useUIStore.getState().togglePanelLayout()
    expect(useUIStore.getState().panelLayout).toBe('classic')
  })
})

describe('requestGlobalSearch', () => {
  it('keeps the selected editor text with the focus signal', () => {
    useUIStore.setState({ globalSearchSignal: 4, globalSearchQuery: null })

    useUIStore.getState().requestGlobalSearch(' selectedName ')

    expect(useUIStore.getState()).toMatchObject({
      view: 'search',
      sidebarOpen: true,
      searchRoot: null,
      globalSearchQuery: 'selectedName',
      globalSearchSignal: 5,
    })
  })

  it('keeps a requested directory and clears a stale global query', () => {
    useUIStore.setState({ globalSearchSignal: 4, globalSearchQuery: 'old query' })

    useUIStore.getState().requestSearch('D:/proj/src')

    expect(useUIStore.getState()).toMatchObject({
      view: 'search',
      sidebarOpen: true,
      searchRoot: 'D:/proj/src',
      globalSearchQuery: null,
      globalSearchSignal: 5,
    })
  })
})

describe('side workspace columns', () => {
  it('toggles dual without forcing the editor off', () => {
    useUIStore.setState({
      panelLayout: 'sideTerminal',
      sideDualTerminal: false,
      sideQuadTerminal: false,
      sideEditorVisible: true,
    })
    useUIStore.getState().toggleSideDualTerminal()
    expect(useUIStore.getState().sideDualTerminal).toBe(true)
    expect(useUIStore.getState().sideQuadTerminal).toBe(false)
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
  })

  it('quad and dual are mutually exclusive', () => {
    useUIStore.setState({
      panelLayout: 'sideTerminal',
      sideDualTerminal: true,
      sideQuadTerminal: false,
      sideEditorVisible: true,
    })
    useUIStore.getState().toggleSideQuadTerminal()
    expect(useUIStore.getState().sideQuadTerminal).toBe(true)
    expect(useUIStore.getState().sideDualTerminal).toBe(false)

    useUIStore.getState().toggleSideDualTerminal()
    expect(useUIStore.getState().sideDualTerminal).toBe(true)
    expect(useUIStore.getState().sideQuadTerminal).toBe(false)
  })

  it('expandSideEditor keeps dual terminal on', () => {
    useUIStore.setState({
      sideDualTerminal: true,
      sideQuadTerminal: false,
      sideEditorVisible: false,
    })
    useUIStore.getState().expandSideEditor()
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
    expect(useUIStore.getState().sideDualTerminal).toBe(true)
  })

  it('expandSideEditor keeps 田 terminal on', () => {
    useUIStore.setState({
      sideDualTerminal: false,
      sideQuadTerminal: true,
      sideEditorVisible: false,
    })
    useUIStore.getState().expandSideEditor()
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
    expect(useUIStore.getState().sideQuadTerminal).toBe(true)
  })
})

describe('full-page views (source control / settings)', () => {
  beforeEach(() => {
    useUIStore.setState({
      panelLayout: 'sideTerminal',
      sideDualTerminal: true,
      sideEditorVisible: false,
    })
  })

  it('shows the editor column temporarily without persisting it', () => {
    useUIStore.getState().toggleActivityView('sourceControl')
    expect(useUIStore.getState().view).toBe('sourceControl')
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
    expect(memory.get(SIDE_WORKSPACE_KEY)).toBeUndefined()
  })

  it('restores the hidden editor column and collapsed sidebar on second click', () => {
    useUIStore.setState({ sidebarOpen: false })
    useUIStore.getState().toggleActivityView('sourceControl')
    useUIStore.getState().toggleActivityView('sourceControl')
    expect(useUIStore.getState()).toMatchObject({
      view: 'explorer',
      sidebarOpen: false,
      sideEditorVisible: false,
      fullPageRestore: null,
    })
  })

  it('restores the editor column when switching to another activity view', () => {
    useUIStore.getState().toggleActivityView('settings')
    useUIStore.getState().toggleActivityView('sourceControl')
    useUIStore.getState().toggleActivityView('search')
    expect(useUIStore.getState().view).toBe('search')
    expect(useUIStore.getState().sideEditorVisible).toBe(false)
  })

  it('keeps a manual editor toggle made while in the full-page view', () => {
    useUIStore.getState().toggleActivityView('sourceControl')
    useUIStore.getState().toggleSideEditorVisible()
    useUIStore.getState().toggleSideEditorVisible()
    useUIStore.getState().toggleActivityView('sourceControl')
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
  })

  it('does not persist the temporary editor column when toggling dual terminal', () => {
    useUIStore.getState().toggleActivityView('sourceControl')
    useUIStore.getState().toggleSideQuadTerminal()
    expect(JSON.parse(memory.get(SIDE_WORKSPACE_KEY) ?? '{}')).toMatchObject({
      editorVisible: false,
    })
  })
})
