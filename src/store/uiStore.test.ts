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

describe('togglePanelLayout', () => {
  it('cycles classic → side → dual+editor', () => {
    useUIStore.getState().togglePanelLayout()
    expect(useUIStore.getState().panelLayout).toBe('sideTerminal')
    expect(useUIStore.getState().sideDualTerminal).toBe(false)
    expect(useUIStore.getState().sideEditorVisible).toBe(true)

    useUIStore.setState({ panelLayoutSwitching: false })
    useUIStore.getState().togglePanelLayout()
    expect(useUIStore.getState().sideDualTerminal).toBe(true)
    expect(useUIStore.getState().sideEditorVisible).toBe(true)

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
