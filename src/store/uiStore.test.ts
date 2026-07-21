import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_LAYOUT_KEY } from '../lib/panelLayoutTemplate'
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
  useUIStore.setState({ panelLayout: 'classic', terminalOpenSignal: 0 })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('togglePanelLayout', () => {
  it('updates the shared layout state and persists each switch', () => {
    const initialTerminalOpenSignal = useUIStore.getState().terminalOpenSignal

    useUIStore.getState().togglePanelLayout()

    expect(useUIStore.getState().panelLayout).toBe('sideTerminal')
    expect(memory.get(PANEL_LAYOUT_KEY)).toBe('sideTerminal')
    expect(useUIStore.getState().terminalOpenSignal).toBe(initialTerminalOpenSignal + 1)

    useUIStore.getState().togglePanelLayout()

    expect(useUIStore.getState().panelLayout).toBe('classic')
    expect(memory.get(PANEL_LAYOUT_KEY)).toBe('classic')
    expect(useUIStore.getState().terminalOpenSignal).toBe(initialTerminalOpenSignal + 2)
  })
})
