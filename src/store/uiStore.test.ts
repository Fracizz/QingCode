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
    sideEditorVisible: true,
    terminalOpenSignal: 0,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setPanelLayoutMode', () => {
  it('applies dual+editor presets', () => {
    useUIStore.getState().setPanelLayoutMode('sideDualEditor')
    expect(useUIStore.getState().panelLayout).toBe('sideTerminal')
    expect(useUIStore.getState().sideDualTerminal).toBe(true)
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
    expect(JSON.parse(memory.get(SIDE_WORKSPACE_KEY) ?? '{}')).toEqual({
      dualTerminal: true,
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

describe('side workspace columns', () => {
  it('toggles dual without forcing the editor off', () => {
    useUIStore.setState({
      panelLayout: 'sideTerminal',
      sideDualTerminal: false,
      sideEditorVisible: true,
    })
    useUIStore.getState().toggleSideDualTerminal()
    expect(useUIStore.getState().sideDualTerminal).toBe(true)
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
  })

  it('expandSideEditor keeps dual terminal on', () => {
    useUIStore.setState({
      sideDualTerminal: true,
      sideEditorVisible: false,
    })
    useUIStore.getState().expandSideEditor()
    expect(useUIStore.getState().sideEditorVisible).toBe(true)
    expect(useUIStore.getState().sideDualTerminal).toBe(true)
  })
})
